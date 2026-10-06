/**
 * Movie Search Controller
 * Handles /movie command with daily limits, humor dialogues, and auto-delete
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber, isGroupMessage, normalizePhoneNumber, resolveNotificationJid } from '../utils/permissions.js';
import { config } from '../config/config.js';
import { atozService } from '../services/AtoZService.js';
import { hdHubMoviesService } from '../services/HdHubMoviesService.js';
import { mkvbaseService } from '../services/MkvbaseService.js';
import { enrichResultsWithDirectLinks } from '../services/HdHubBypassService.js';
import { pronoobDriveService } from '../services/PronoobDriveService.js';
import { movieCacheService, cloneMovieResults } from '../services/MovieCacheService.js';
import { urlShortener } from '../utils/urlShortener.js';
import { safeSendMessage, fastSendMessage, resolveOutboundJid } from '../utils/waMessage.js';
import { messageQueue } from '../utils/messageQueue.js';
import { formatProgressLine } from '../utils/progressBar.js';
import { audioFromFilename, qualityFromFilename } from '../utils/movieMetadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QR_IMAGE_PATH = resolve(__dirname, '../../assets/payment_qr.jpg');

const DAILY_LIMIT = config.MOVIE_DAILY_LIMIT || 3;
const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours
const SUMMARY_HOUR = 23;
const SUMMARY_MINUTE = 55;
const WEEKLY_DAY = 0; // Sunday
const WEEKLY_HOUR = 12;
const WEEKLY_MINUTE = 0;
const PAYMENT_CONTACT = '917887499710';
const SEARCH_LOG_JID = `${PAYMENT_CONTACT}@s.whatsapp.net`;

const MOVIE_EMOJIS = ['🎬', '🍿', '🎥', '📽️', '🎞️', '🎭', '🌟', '⭐', '🔥', '💎'];

function formatDailySummary(stats) {
    const { totalSearches, uniqueUsers, topMovies, movieOfTheDay, date } = stats;

    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  📊 *DAILY MOVIE RECAP* 📊  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${date}*\n`;
    text += '─────────────────────────────\n\n';

    text += `🔍 *Total Searches:* ${totalSearches}\n`;
    text += `👥 *Users Who Searched:* ${uniqueUsers}\n\n`;

    if (movieOfTheDay) {
        text += '🏆 *MOVIE OF THE DAY*\n';
        text += `   ${MOVIE_EMOJIS[Math.floor(Math.random() * MOVIE_EMOJIS.length)]} *${movieOfTheDay.query}* — searched ${movieOfTheDay.count} time(s)\n\n`;
    }

    if (topMovies.length) {
        text += '🔥 *TOP 5 SEARCHED*\n';
        topMovies.forEach((m, i) => {
            const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || `${i + 1}.`;
            text += `   ${medal} _${m.query}_ — ${m.count} search(es)\n`;
        });
        text += '\n';
    }

    text += '─────────────────────────────\n';

    if (totalSearches === 0) {
        text += '📭 _No one searched today… bots need love too!_ 🥲\n';
    } else if (totalSearches < 5) {
        text += '🌱 _Quiet day at the movies! Search more tomorrow_ 🍿\n';
    } else if (totalSearches < 20) {
        text += '🔥 _Decent day! The popcorn was popping_ 🍿\n';
    } else {
        text += '🚀 _Blockbuster day! You all went full cinema mode_ 🎉\n';
    }

    text += '─────────────────────────────\n';
    text += '💡 _Try `/movie <name>` to search_ 🎬';

    return text;
}

function formatWeeklyTrending(movies, weekLabel, source) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃ 🔥 *WEEKLY TRENDING MOVIES* 🔥┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${weekLabel}*\n`;
    text += '─────────────────────────────\n\n';

    if (!movies.length) {
        text += '📭 _Nothing trending this week!_\n';
        text += '_Be the first → `/movie <name>`_ 🍿\n';
    } else if (source === 'tmdb') {
        text += '🌍 *Trending worldwide right now:*\n\n';
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        movies.forEach((m, i) => {
            const badge = medals[i] || `${i + 1}.`;
            const year = m.year ? ` (${m.year})` : '';
            const rating = m.rating ? ` ⭐ ${m.rating}` : '';
            text += `${badge} *${m.title}*${year}${rating}\n`;
            if (m.plot) text += `     _${m.plot}_\n`;
            text += '\n';
        });
    } else {
        text += '🎬 *Most searched this week:*\n\n';
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        movies.forEach((m, i) => {
            const badge = medals[i] || `${i + 1}.`;
            const bar = '🟩'.repeat(Math.min(m.count, 10));
            text += `${badge} *${m.title}*\n`;
            text += `     ${bar} (${m.count})\n\n`;
        });
    }

    text += '─────────────────────────────\n';
    if (source === 'tmdb' && movies.length) {
        text += '✅ _Already in Sassy\'s database — just search!_\n';
    }
    text += '🍿 _Try any movie → `/movie <name>`_\n';
    text += '⭐ _Go Premium for unlimited searches!_';

    return text;
}

const TMDB_GENRES = {
    action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80,
    documentary: 99, drama: 18, family: 10751, fantasy: 14, history: 36,
    horror: 27, music: 10402, mystery: 9648, romance: 10749, scifi: 878,
    'sci-fi': 878, thriller: 53, war: 10752, western: 37,
};

function formatUpcomingMovies(movies, dateRange) {
    let text = '╔════════════════════════════════╗\n';
    text += '║  🎬 UPCOMING MOVIES 🎬       ║\n';
    text += '╚════════════════════════════════╝\n\n';
    text += `📅 *${dateRange}*\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    if (!movies.length) {
        text += '📭 _No upcoming releases found for this period._\n';
    } else {
        movies.forEach((m, i) => {
            text += `*${i + 1}.* 🎥 *${m.title}*\n`;
            text += `   📅 ${m.releaseDate} | 🎭 ${m.genres}\n`;
            if (m.cast) text += `   👥 *Cast:* ${m.cast}\n`;
            if (m.plot) text += `   📝 _${m.plot}_\n`;
            text += '\n';
        });
    }

    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '🍿 _Use `/movie <name>` to search & download!_';
    return text;
}

function formatGenreMovies(genre, movies) {
    const genreTitle = genre.charAt(0).toUpperCase() + genre.slice(1);
    let text = '╔════════════════════════════════╗\n';
    text += `║  🎭 TOP ${genreTitle.toUpperCase()} MOVIES 🎭     ║\n`;
    text += '╚════════════════════════════════╝\n\n';
    text += `🔥 *Popular ${genreTitle} Movies Right Now:*\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    if (!movies.length) {
        text += '📭 _No movies found for this genre._\n';
    } else {
        movies.forEach((m, i) => {
            const rating = m.rating ? ` ⭐ ${m.rating}` : '';
            text += `*${i + 1}.* 🎥 *${m.title}* (${m.year})${rating}\n`;
            if (m.cast) text += `   👥 *Cast:* ${m.cast}\n`;
            if (m.plot) text += `   📝 _${m.plot}_\n`;
            text += '\n';
        });
    }

    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += `🎭 _Available genres: action, comedy, horror, thriller, romance, drama, scifi, adventure, animation, mystery_\n`;
    text += '🍿 _Use `/movie <name>` to search & download!_';
    return text;
}

const SEARCH_DIALOGUES = [
    // Bollywood classics
    "🎬 _\"Ek baar jo maine commitment kar di, uske baad toh main khud ki bhi nahi sunta...\"_ — Searching! 🔍",
    "🎬 _\"Mogambo khush hua!\"_ — Your movie is being found... 🔍",
    "🎬 _\"Mere paas maa hai... aur tera movie bhi hoga!\"_ — Searching... 🔍",
    "🎬 _\"Kitne aadmi the?\"_ — Counting your results... 🔍",
    "🎬 _\"Picture abhi baaki hai mere dost...\"_ — Almost there! 🔍",
    "🎬 _\"Don ko pakadna mushkil hi nahi, namumkin hai... but finding movies? Easy!\"_ — On it! 🔍",
    "🎬 _\"Babuchak, ruk ja... results aa rahe hain!\"_ — Hold on! 🔍",
    "🎬 _\"Ye bik gayi hai gormint... but movies are still free here!\"_ — Searching... 🔍",
    "🎬 _\"Pushpa, I hate tears... but I love finding movies!\"_ — Jhukega nahi! 🔍",
    "🎬 _\"Hum jahan khade hote hain, line wahin se shuru hoti hai...\"_ — Your queue is #1! 🔍",
    "🎬 _\"Zindagi mein do cheezein chahiye... WiFi aur Movies!\"_ — Finding both... 🔍",
    "🎬 _\"Baburao, ye download karke de do...\"_ — Processing request! 🔍",
    "🎬 _\"Sharma ji ke ladke ne toh pehle hi download kar liya...\"_ — Searching fast! 🔍",
    "🎬 _\"Tumse na ho payega... chhod do! Nahi, main karunga!\"_ — Finding it! 🔍",
    "🎬 _\"Aaj mere paas gaadi hai, bangla hai, movie bhi hoga!\"_ — Searching... 🔍",
    "🎬 _\"Apun ka time aayega... aur tera movie bhi!\"_ — Processing! 🔍",
    "🎬 _\"Chulbul Pandey searching your movie, item milega!\"_ — On it! 🔍",
    "🎬 _\"Rishte mein toh hum tumhare bot lagte hain...\"_ — Searching! 🔍",
    "🎬 _\"Jali ko aag kehte hain, bujhi ko raakh... movie ko download!\"_ — Finding! 🔍",
    "🎬 _\"Keh ke lunga... tera movie!\"_ — Searching hard! 🔍",
    "🎬 _\"All izz well, movie mil jayegi!\"_ — Searching... 🔍",
    "🎬 _\"Tension nahi lene ka, movie aa rahi hai!\"_ — Hold on! 🔍",
    "🎬 _\"Main aaj bhi phenke hue paise nahi uthata... but movies dhundhta hoon!\"_ — Searching! 🔍",
    "🎬 _\"Bas kar pagle, rulaayega kya? Movie dhundh raha hoon!\"_ — Almost! 🔍",
    "🎬 _\"Circuit, bhai ka movie dhundh!\"_ — Processing! 🔍",
    "🎬 _\"Log kehte hain iske baap ka server hai... dhundhega toh milega!\"_ — On it! 🔍",
    "🎬 _\"Yeh Baburao ka style hai!\"_ — Searching in style! 🔍",
    "🎬 _\"Bade bade deshon mein aisi chhoti chhoti searches hoti rehti hain...\"_ — Finding! 🔍",
    "🎬 _\"Senorita, aapki movie dhundhi ja rahi hai!\"_ — Almost there! 🔍",
    "🎬 _\"Main udna chahta hoon, daudna chahta hoon, movie dhundhna chahta hoon!\"_ — Searching! 🔍",
    "🎬 _\"Dialogue bolne mein time lagta hai, movie dhundhne mein nahi!\"_ — Quick search! 🔍",
    "🎬 _\"Chal Dhanno! Movie dhundhne chal!\"_ — Galloping to results! 🔍",
    "🎬 _\"Bhai log, movie ka intezaam ho raha hai!\"_ — Hold tight! 🔍",
    "🎬 _\"Hera Pheri mein movie kaise dhundhe? Aise!\"_ — Searching! 🔍",
    "🎬 _\"Ye lo, Paisa hi Paisa hoga... aur movie bhi!\"_ — Finding! 🔍",
    "🎬 _\"Yahan se daffa ho jao... movie dhundh ke aa raha hoon!\"_ — On my way! 🔍",
    "🎬 _\"Aamdani atthanni kharcha rupaiya... but downloading is free!\"_ — Searching! 🔍",
    "🎬 _\"Main apni favourite hoon... aur movie bhi dhundh lungi!\"_ — On it! 🔍",
    "🎬 _\"Jab tak todenge nahi, tab tak chhodenge nahi!\"_ — Searching hard! 🔍",
    "🎬 _\"Beta, tumse na ho payega... mujhe do!\"_ — Bot searching! 🔍",
    "🎬 _\"Itna sannata kyun hai bhai? Movie dhundh raha hoon!\"_ — Processing! 🔍",
    "🎬 _\"Thapad se darr nahi lagta sahab, movie na milne se lagta hai!\"_ — Finding! 🔍",
    "🎬 _\"Koi dhanda chhota nahi hota... aur koi movie unfindable nahi!\"_ — Searching! 🔍",
    "🎬 _\"Pehle movie aata tha, ab movie dhundhte hain!\"_ — On it! 🔍",
    "🎬 _\"Tera movie toh pakka milega, Gabbar guarantee deta hai!\"_ — Searching! 🔍",
    "🎬 _\"Mein hoon na... movie dhundh raha hoon!\"_ — Hold on! 🔍",
    "🎬 _\"Sardaar Bucking Fam hai... movie dhundh raha hai!\"_ — Processing! 🔍",
    "🎬 _\"Khiladi No.1 searching your movie!\"_ — Almost done! 🔍",
    "🎬 _\"Devdas toh movie ke bina mar gaya... tu wait kar!\"_ — Finding! 🔍",
    "🎬 _\"Arey O Sambha... movie dhundh!\"_ — Searching vault! 🔍",
    // Hollywood classics
    "🎬 _\"I'll be back... with your results!\"_ — Hold tight! 🔍",
    "🎬 _\"Why so serious?\"_ — Let me find that movie for you 🃏🔍",
    "🎬 _\"Thanos snapped, but your movie survived!\"_ — Finding it now... 🔍",
    "🎬 _\"With great power comes great movies...\"_ — Searching the multiverse! 🔍",
    "🎬 _\"I am Iron Man... and I found your download!\"_ — Processing... 🔍",
    "🎬 _\"Avengers... Assemble your downloads!\"_ — Gathering results... 🔍",
    "🎬 _\"May the Force be with your download speed!\"_ — Searching galaxy... 🔍",
    "🎬 _\"To infinity... and beyond! Finding your movie!\"_ — Searching! 🔍",
    "🎬 _\"I'm gonna make him an offer he can't refuse...\"_ — Your movie! 🔍",
    "🎬 _\"Here's looking at you, kid... and your movie!\"_ — Searching! 🔍",
    "🎬 _\"You talking to me? I'm finding your movie!\"_ — On it! 🔍",
    "🎬 _\"Houston, we have a movie to find!\"_ — Launching search! 🔍",
    "🎬 _\"Elementary, my dear Watson... the movie is near!\"_ — Deducing! 🔍",
    "🎬 _\"After all this time? Always... searching for your movie!\"_ — Finding! 🔍",
    "🎬 _\"I am Groot... and I'm searching!\"_ — Growing results! 🔍",
    "🎬 _\"It's not who I am underneath, but what I download that defines me!\"_ — Searching! 🔍",
    "🎬 _\"Wakanda Forever! Searching the Vibranium servers!\"_ — On it! 🔍",
    "🎬 _\"I see dead movies... wait, found alive ones!\"_ — Searching! 🔍",
    "🎬 _\"Life is like a box of movies, you never know what you'll find!\"_ — Searching! 🔍",
    "🎬 _\"Keep your friends close, and your movies closer!\"_ — Finding! 🔍",
    "🎬 _\"They may take our lives, but they'll never take our movies!\"_ — Searching! 🔍",
    "🎬 _\"Just keep searching, just keep searching...\"_ — Dory mode! 🔍",
    "🎬 _\"I volunteer as tribute... to find your movie!\"_ — On it! 🔍",
    "🎬 _\"Expecto Patronum!\"_ — Summoning your movie results! 🔍",
    "🎬 _\"You shall not pass... without your download link!\"_ — Searching! 🔍",
    "🎬 _\"Winter is coming... but your movie is coming faster!\"_ — Finding! 🔍",
    "🎬 _\"In a galaxy far, far away... your movie exists!\"_ — Searching! 🔍",
    "🎬 _\"It's a bird! It's a plane! It's your movie results!\"_ — Almost! 🔍",
    "🎬 _\"I am inevitable... and so are your results!\"_ — Searching! 🔍",
    "🎬 _\"That's what I do. I drink coffee and I find movies!\"_ — On it! 🔍",
    "🎬 _\"Say hello to my little search engine!\"_ — Finding! 🔍",
    "🎬 _\"Frankly my dear, I do give a damn about your movie!\"_ — Searching! 🔍",
    "🎬 _\"We're gonna need a bigger download link!\"_ — Finding! 🔍",
    "🎬 _\"One does not simply walk into Mordor... but one can search movies!\"_ — On it! 🔍",
    "🎬 _\"Bond. James Bond. Searching for your movie!\"_ — Undercover search! 🔍",
    "🎬 _\"Roads? Where we're going, we don't need roads... just downloads!\"_ — Searching! 🔍",
    "🎬 _\"Not all those who wander are lost... some are searching movies!\"_ — Finding! 🔍",
    "🎬 _\"My precious... movie results!\"_ — Gollum searching! 🔍",
    "🎬 _\"I'll find your movie. I have a very particular set of skills!\"_ — Searching! 🔍",
    "🎬 _\"Hasta la vista, baby... results incoming!\"_ — Processing! 🔍",
    // Fun originals
    "🎬 _\"Server pe raid maar rahe hain bhai...\"_ — Finding your movie! 🔍",
    "🎬 _\"Netflix ko competition de rahe hain free mein!\"_ — Searching! 🔍",
    "🎬 _\"Popcorn ready kar, movie aa rahi hai!\"_ — Almost there! 🔍",
    "🎬 _\"Ek second... AI apna kaam kar raha hai!\"_ — Processing! 🔍",
    "🎬 _\"Downloading happiness for you...\"_ — Searching database! 🔍",
    "🎬 _\"Bro chill, bot kaam kar raha hai!\"_ — Finding your movie! 🔍",
    "🎬 _\"VPN on karke baitho, link aa raha hai!\"_ — Searching! 🔍",
    "🎬 _\"Internet ki duniya mein kuch bhi mumkin hai!\"_ — Finding! 🔍",
    "🎬 _\"Torrent se tez dhundhta hai ye bot!\"_ — Searching fast! 🔍",
    "🎬 _\"Relax bro, free mein milega... bas ruk!\"_ — Processing! 🔍",
    "🎬 _\"Data pack bachao, movie seedha yahaan se lo!\"_ — Finding! 🔍",
    "🎬 _\"Piracy is wrong... but searching is free!\"_ — On it! 🔍",
];

const NO_RESULTS_DIALOGUES = [
    "🎭 _\"Ye movie toh Gabbar bhi nahi dhundh paaya!\"_\nNo results found. Try a different name!",
    "🎭 _\"Houston, we have a problem...\"_\nNo movies found for that search. Try again!",
    "🎭 _\"Kuch toh gadbad hai Daya!\"_\nCouldn't find any movies. Check the spelling!",
    "🎭 _\"I looked everywhere... even in the Upside Down!\"_\nNo results. Try another name!",
    "🎭 _\"Thanos must have snapped this movie away...\"_\nNo results found! Try something else.",
    "🎭 _\"Mogambo naakhush hua...\"_\nMovie not found! Try another spelling.",
    "🎭 _\"Baburao ko bhi nahi mila...\"_\nNo results! Double check the name.",
    "🎭 _\"Even Doctor Strange couldn't find this in 14 million timelines!\"_\nTry different keywords!",
    "🎭 _\"Gabbar ne poori duniya dhundhi... nahi mila!\"_\nNo results. Try shorter name!",
    "🎭 _\"404: Movie not found in the multiverse!\"_\nTry a different search term!",
    "🎭 _\"Ye movie toh Bermuda Triangle mein gayab ho gayi!\"_\nNo results found!",
    "🎭 _\"Circuit, bhai ko movie nahi mili!\"_\nTry searching with movie year too!",
    "🎭 _\"JARVIS couldn't locate this one, sir!\"_\nTry alternate title or spelling!",
    "🎭 _\"This movie is more hidden than One Piece treasure!\"_\nNo results! Try again.",
    "🎭 _\"Gandalf searched the mines of Moria... nothing!\"_\nTry different keywords!",
    "🎭 _\"Na server mein hai, na database mein... nahi mila bhai!\"_\nTry another name!",
    "🎭 _\"Sherlock Holmes bhi confuse ho gaya!\"_\nNo results. Check spelling!",
    "🎭 _\"Hera Pheri ho gayi search mein!\"_\nNothing found. Try again with correct name!",
    "🎭 _\"Ye movie abhi release nahi hui shayad!\"_\nNo results found. Try another!",
    "🎭 _\"Server ne kaha — ye movie mujhe bhi nahi pata!\"_\nTry a different search!",
];

function getRandomDialogue(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function formatSourceLine(emoji, label, status, detail = '') {
    let line;
    if (status === 'done') {
        line = `${emoji} ${label} ✓${detail ? ` (${detail})` : ''}`;
    } else {
        line = `${emoji} ${label} …`;
    }
    return `> ${line}`;
}

function formatMovieSearchProgress(dialogue, query, state) {
    const percent = state.percent ?? 0;

    let msg = `${dialogue}\n\n`;
    msg += `*$ movie --search*\n`;
    msg += `> *${query}*\n`;
    msg += `${formatProgressLine('SRC', percent, { decimals: 1 })}\n`;

    if (state.cacheMode) {
        msg += `> 📦 Vault cache · ${state.resultCount ?? 0} title(s)`;
        if (state.ageHours != null) {
            msg += ` · ${state.ageHours}h old`;
        }
        msg += '\n';
        if (state.fuzzyMatch) {
            msg += '> 🔎 Fuzzy vault match\n';
        }
        if (state.staleCache) {
            msg += '> ⚠️ Saved links — APIs slow/offline\n';
        }
        if (state.refreshing) {
            msg += '> 🔄 Refreshing vault in background\n';
        }
        if (state.shorten === 'loading') {
            msg += '> 🔗 Shortening links…\n';
        }
        return msg.trimEnd();
    }

    msg += `\n*$ sources*\n`;

    if (state.vault !== undefined) {
        const detail = state.vaultCount != null ? `${state.vaultCount} found` : '';
        msg += `${formatSourceLine('🗄️', 'ProNooB Drive', state.vault, detail)}\n`;
    }
    if (state.hd !== undefined) {
        const detail = state.hdCount != null ? `${state.hdCount} found` : '';
        msg += `${formatSourceLine('📡', 'HDHub4u', state.hd, detail)}\n`;
    }
    if (state.drive !== undefined) {
        const detail = state.driveCount != null ? `${state.driveCount} found` : '';
        msg += `${formatSourceLine('💾', 'Drive vault', state.drive, detail)}\n`;
    }
    if (state.atoz !== undefined) {
        const detail = state.atozCount != null ? `${state.atozCount} found` : '';
        msg += `${formatSourceLine('📺', 'AtoZ cinema', state.atoz, detail)}\n`;
    }
    if (state.shorten === 'loading') {
        msg += '> 🔗 Shortening links…\n';
    }

    return msg.trimEnd();
}

/** Progress edits sit behind normal command replies so /movie never starves the chat. */
const MOVIE_PROGRESS_PRIORITY = 2;
/** Bulk result dumps sit behind progress + commands. */
const MOVIE_RESULT_PRIORITY = 3;

/**
 * Progress bar via rare milestone edits only (no pulse).
 * Fully await each edit — never Promise.race-abandon (late edits resurrect deleted loaders).
 */
function makeMovieProgressEditor(sock, chatId, messageKey, dialogue, query) {
    let closed = false;
    let editTail = Promise.resolve();
    let lastText = '';
    let currentState = {
        percent: 10,
        vault: 'pending',
        hd: 'loading',
        drive: 'pending',
        atoz: 'pending',
    };

    const format = () => formatMovieSearchProgress(dialogue, query, currentState);

    const queueEdit = () => {
        if (closed || !messageKey?.id || !sock?.sendMessage) return editTail;
        const text = format();
        if (text === lastText) return editTail;
        lastText = text;
        const key = normalizeOwnMessageKey(messageKey, chatId);
        const jid = resolveOutboundJid(key, chatId);
        editTail = editTail
            .then(async () => {
                if (closed) return;
                try {
                    // ponytail: queue priority 2 — commands (0–1) cut in; upgrade to direct sock if edits lag badly
                    await messageQueue.enqueue(chatId, async () => {
                        if (closed) return;
                        await sock.sendMessage(jid, { text, edit: key, linkPreview: false });
                    }, MOVIE_PROGRESS_PRIORITY);
                } catch (err) {
                    logger.warn(`Movie progress edit skipped: ${err?.message || err}`);
                }
            })
            .catch(() => {});
        return editTail;
    };

    const flush = async (patch = {}) => {
        if (closed) return;
        currentState = { ...currentState, ...patch };
        await queueEdit();
    };

    const update = async (patch = {}, { force = false } = {}) => {
        if (!force) return;
        await flush(patch);
    };

    const startPulse = () => {};
    const stopPulse = () => {};

    const close = async () => {
        closed = true;
        await editTail.catch(() => {});
        // Let WhatsApp ack the last edit before revoke — cuts Baileys retry ghosts
        await new Promise((r) => setTimeout(r, 600));
    };

    return { update, flush, startPulse, stopPulse, close, format };
}

function normalizeOwnMessageKey(messageKey, chatId) {
    if (!messageKey?.id) return null;
    return {
        remoteJid: chatId || messageKey.remoteJid,
        id: messageKey.id,
        fromMe: true,
        ...(messageKey.participant ? { participant: messageKey.participant } : {}),
    };
}

/** Await delete (+ retry) with a proper fromMe key so group deletes actually land. */
async function deleteMovieProgressMessage(sock, chatId, messageKey) {
    const key = normalizeOwnMessageKey(messageKey, chatId);
    if (!key || !sock?.sendMessage) return;
    const jid = resolveOutboundJid(key, chatId);
    for (let i = 0; i < 2; i++) {
        try {
            await sock.sendMessage(jid, { delete: key });
            return;
        } catch (err) {
            logger.warn(`Movie loader delete attempt ${i + 1} failed: ${err?.message || err}`);
            await new Promise((r) => setTimeout(r, 500));
        }
    }
}

/**
 * One in-flight /movie per user per chat (not whole-chat).
 * Global slot cap keeps scrapes from melting the host while other users still run in parallel.
 */
const movieSearchByUser = new Map();
const MOVIE_SEARCH_MAX = Math.max(
    1,
    Math.min(6, parseInt(process.env.MOVIE_SEARCH_MAX, 10) || 4)
);
let movieSearchActive = 0;
/** @type {Array<() => void>} */
const movieSearchWaiters = [];

async function withMovieSearchSlot(fn) {
    if (movieSearchActive >= MOVIE_SEARCH_MAX) {
        await new Promise((resolve) => {
            movieSearchWaiters.push(resolve);
        });
    }
    movieSearchActive += 1;
    try {
        return await fn();
    } finally {
        movieSearchActive -= 1;
        const next = movieSearchWaiters.shift();
        if (next) next();
    }
}

export function getMovieSearchConcurrency() {
    return {
        active: movieSearchActive,
        max: MOVIE_SEARCH_MAX,
        waiting: movieSearchWaiters.length,
    };
}

async function withMovieSearchLock(chatId, senderJid, fn) {
    const key = `${chatId}|${senderJid || 'anon'}`;
    const prev = movieSearchByUser.get(key) || Promise.resolve();
    let unlock;
    const held = new Promise((resolve) => {
        unlock = resolve;
    });
    const tail = prev.then(() => held);
    movieSearchByUser.set(key, tail);
    await prev.catch(() => {});
    try {
        return await withMovieSearchSlot(fn);
    } finally {
        unlock();
        if (movieSearchByUser.get(key) === tail) {
            movieSearchByUser.delete(key);
        }
    }
}

function cleanTitle(raw) {
    return raw.replace(/^\*+|\*+$/g, '').trim();
}

/** Prefer results that match more query words in title or description. */
function rankMovieResults(results, query) {
    const words = String(query || '')
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ''))
        .filter((w) => w.length > 2);

    if (!words.length) {
        return results;
    }

    const score = (item) => {
        const t = `${item?.title || ''} ${item?.description || ''}`.toLowerCase();
        let hits = 0;
        for (const w of words) {
            if (t.includes(w)) {
                hits++;
            }
        }
        return hits / words.length;
    };

    return [...results].sort((a, b) => score(b) - score(a));
}

const MOVIE_SEND_OPTS = { forceQuote: true };

function movieQuickSend(sock, chatId, content, originalMsg = null, priority = MOVIE_PROGRESS_PRIORITY) {
    if (isGroupMessage(chatId)) {
        return fastSendMessage(sock, chatId, content, originalMsg, priority, MOVIE_SEND_OPTS);
    }
    return safeSendMessage(sock, chatId, content, originalMsg, { queuePriority: priority, forceQuote: true });
}

async function movieResultSend(sock, chatId, content, originalMsg = null) {
    if (isGroupMessage(chatId)) {
        return fastSendMessage(sock, chatId, content, originalMsg, MOVIE_RESULT_PRIORITY, MOVIE_SEND_OPTS);
    }
    return safeSendMessage(sock, chatId, content, originalMsg, { queuePriority: MOVIE_RESULT_PRIORITY, forceQuote: true });
}

const WHATSAPP_MAX_LENGTH = 4096;
const SEARCH_COUNT_FOOTER_RESERVE = 120;

function parseLinkSizeLabel(sizeLabel) {
    if (!sizeLabel) return { quality: '', fileSize: '' };
    const parts = String(sizeLabel).split(' • ').map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
        return { quality: '', fileSize: parts[0] || sizeLabel };
    }
    return { quality: parts[0], fileSize: parts.slice(1).join(' • ') };
}

function formatMovieResultBlock(item, globalIdx) {
    const title = cleanTitle(item.title);
    const sourceTag = item.source ? ` [${item.source}]` : '';
    let block = `*${globalIdx}. ${title}*${sourceTag}\n`;

    if (item.links?.length) {
        item.links.forEach((link) => {
            const parsed = parseLinkSizeLabel(link.size);
            const quality = parsed.quality || link.quality || qualityFromFilename(link.rawFilename || title);
            const fileSize = parsed.fileSize || link.size || '';
            const audio = link.audio || audioFromFilename(link.rawFilename || title);
            const label = String(link.label || '').trim();
            const detailLine = quality && fileSize && fileSize !== quality
                ? `${quality} · ${fileSize}`
                : (quality || fileSize);

            if (label) {
                block += `┌ 📌 ${label}\n`;
                if (detailLine && detailLine !== label) {
                    block += `│ 📦 ${detailLine}\n`;
                }
            } else if (detailLine) {
                block += `┌ ${detailLine}\n`;
            } else {
                block += '┌ Download\n';
            }

            if (audio) {
                block += `│ 🔊 ${audio}\n`;
            }
            block += `└ 🔗 ${link.url}\n`;
        });
    }

    return `${block}\n`;
}

function formatMovieResultsFooter() {
    let text = '─────────────────────────────\n';
    text += '💡 _Click link to download/watch_\n';
    text += '⚠️ _Use VPN if links are blocked_\n';
    text += '⏰ _Download links expire in 7 hours_\n';
    text += '─────────────────────────────\n';
    text += '🤖 _Powered by Sassy Bot_ ⚡\n';
    text += '⏰ _This message auto-deletes in 5 hours_';
    return text;
}

function formatMovieResultsHeader(query, totalResults, pushName, sources, { totalPages = 1, cacheNote = '' } = {}) {
    let text = '';

    if (pushName) {
        text += `🎉 Hey *${pushName}*! Here are your results 🍿\n\n`;
    }
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  🎬 *MOVIE SEARCH RESULTS*  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🔍 *Query:* _"${query}"_\n`;
    text += `📊 *Found:* ${totalResults} result(s)`;
    if (totalPages > 1) {
        text += ` _(${totalPages} messages)_`;
    }
    text += '\n';
    if (cacheNote) {
        text += `${cacheNote}\n`;
    }
    if (sources.length > 0) {
        text += `🌐 *Sources:* ${sources.join(', ')}\n`;
    }
    text += '─────────────────────────────\n\n';
    return text;
}

function formatMovieResultsContinuation(from, to, totalResults) {
    return `📄 *Results ${from}-${to} of ${totalResults}*\n─────────────────────────────\n\n`;
}

function formatMovieResults(query, results, pushName = '', sources = [], { cacheNote = '' } = {}) {
    if (!results.length) return [];

    const footer = formatMovieResultsFooter();
    const blocks = results.map((item, idx) => formatMovieResultBlock(item, idx + 1));
    const totalResults = results.length;
    const maxLen = WHATSAPP_MAX_LENGTH - SEARCH_COUNT_FOOTER_RESERVE;
    const messages = [];
    let chunkStart = 0;

    while (chunkStart < blocks.length) {
        const isFirst = messages.length === 0;
        let body = '';
        let i = chunkStart;

        while (i < blocks.length) {
            const chunkEnd = i + 1;
            const header = isFirst
                ? formatMovieResultsHeader(query, totalResults, pushName, sources, { cacheNote })
                : formatMovieResultsContinuation(chunkStart + 1, chunkEnd, totalResults);
            const atEnd = chunkEnd === blocks.length;
            const candidate = header + body + blocks[i] + (atEnd ? footer : '');

            if (candidate.length > maxLen && i > chunkStart) break;

            body += blocks[i];
            i++;
        }

        const chunkEnd = i;
        const header = isFirst
            ? formatMovieResultsHeader(query, totalResults, pushName, sources, { cacheNote })
            : formatMovieResultsContinuation(chunkStart + 1, chunkEnd, totalResults);

        let text = header + body;
        if (chunkEnd === blocks.length) {
            text += footer;
        }

        messages.push(text);
        chunkStart = chunkEnd;
    }

    if (messages.length > 1) {
        const baseHeader = formatMovieResultsHeader(query, totalResults, pushName, sources, { cacheNote });
        const multiHeader = formatMovieResultsHeader(query, totalResults, pushName, sources, {
            totalPages: messages.length,
            cacheNote,
        });
        messages[0] = multiHeader + messages[0].slice(baseHeader.length);
    }

    return messages;
}

function formatLimitReached(remaining) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃   ⛔ *DAILY LIMIT REACHED*   ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🎬 You've used all *${DAILY_LIMIT}* free searches today!\n\n`;
    text += '─────────────────────────────\n';
    text += '🌟 *Want unlimited searches?*\n\n';
    text += '1️⃣ Scan the QR code below to pay\n';
    text += `2️⃣ Send the payment screenshot to:\n`;
    text += `    📱 *wa.me/${PAYMENT_CONTACT}*\n`;
    text += '3️⃣ Get unlimited access! 🎉\n';
    text += '─────────────────────────────\n\n';
    text += '_Your limit resets at midnight IST_ 🕛';

    return text;
}

class MovieController {
    constructor(mongoDb, groupManager) {
        this.mongoDb = mongoDb;
        this.groupManager = groupManager;
        this.searchLimits = null;
        this._activeDeleteTimers = 0;
        this._sock = null;
        this._getSock = null;
        /** @type {Map<string, { unlimited: boolean, at: number }>} */
        this._unlimitedCache = new Map();
    }

    async init() {
        this.searchLimits = this.mongoDb.collection('movie_search_limits');
        await this.searchLimits.createIndex(
            { user_id: 1, date: 1 },
            { unique: true, name: 'user_daily_limit' }
        );

        this.searchLog = this.mongoDb.collection('movie_search_log');
        await this.searchLog.createIndex({ date: 1, chat_id: 1 }, { name: 'search_log_date_chat' });
        await this.searchLog.createIndex(
            { date: 1, chat_id: 1, query_lower: 1 },
            { name: 'search_log_query' }
        );

        await movieCacheService.init(this.mongoDb);

        this._startKeepAlive();
        this._scheduleVaultPrewarm();
        this._scheduleDailySummary();
        this._scheduleWeeklyTrending();
        this._scheduleWeeklyUpcoming();
        this._scheduleExpireLimitAlerts();
        logger.info('Movie search controller ready');
    }

    _startKeepAlive() {
        if (process.env.MOVIE_API_KEEPALIVE_ENABLED === 'false') {
            logger.info('Movie API keep-alive disabled (MOVIE_API_KEEPALIVE_ENABLED=false)');
            return;
        }
        pronoobDriveService.startKeepAlive();
        atozService.startKeepAlive();
        hdHubMoviesService.startKeepAlive();
        mkvbaseService.startKeepAlive();
    }

    stopKeepAlive() {
        pronoobDriveService.stopKeepAlive();
        atozService.stopKeepAlive();
        hdHubMoviesService.stopKeepAlive();
        mkvbaseService.stopKeepAlive();
    }

    async logSearch(userId, query, resultCount, chatId) {
        try {
            const normalizedUserId = normalizePhoneNumber(userId);
            await this.searchLog.insertOne({
                user_id: normalizedUserId,
                query: query.slice(0, 100),
                query_lower: query.toLowerCase().slice(0, 100),
                result_count: resultCount,
                chat_id: chatId,
                date: this.getTodayDateStr(),
                created_at: new Date(),
            });
        } catch (err) {
            logger.warn(`Failed to log movie search: ${err.message}`);
        }
    }

    async getDailySummaryStats(dateStr, chatId) {
        const matchFilter = { date: dateStr };
        if (chatId) matchFilter.chat_id = chatId;

        const pipeline = [
            { $match: matchFilter },
            { $group: {
                _id: '$query_lower',
                query: { $first: '$query' },
                count: { $sum: 1 },
                users: { $addToSet: '$user_id' },
            }},
            { $sort: { count: -1 } },
        ];
        const grouped = await this.searchLog.aggregate(pipeline).toArray();

        const totalSearches = grouped.reduce((sum, g) => sum + g.count, 0);
        const allUsers = new Set();
        grouped.forEach((g) => g.users.forEach((u) => allUsers.add(u)));

        const topMovies = grouped.slice(0, 5).map((g) => ({
            query: g.query,
            count: g.count,
        }));
        const movieOfTheDay = topMovies[0] || null;

        const dateFormatted = new Date(dateStr + 'T00:00:00+05:30').toLocaleDateString('en-IN', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });

        return { totalSearches, uniqueUsers: allUsers.size, topMovies, movieOfTheDay, date: dateFormatted };
    }

    _scheduleDailySummary() {
        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);
            target.setHours(SUMMARY_HOUR, SUMMARY_MINUTE, 0, 0);
            if (target <= ist) target.setDate(target.getDate() + 1);

            const delayMs = target.getTime() - ist.getTime();
            const label = target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                + ` ${SUMMARY_HOUR}:${String(SUMMARY_MINUTE).padStart(2, '0')}`;
            logger.info(`🎬 Next movie summary scheduled at ${label} IST (in ${Math.round(delayMs / 60000)}m)`);

            this._summaryTimer = setTimeout(async () => {
                await this._postDailySummary();
                scheduleNext();
            }, delayMs);
        };
        scheduleNext();
    }

    async _postDailySummary() {
        try {
            if (!this._sock) {
                logger.warn('Movie summary: no socket available, skipping');
                return;
            }

            const dateStr = this.getTodayDateStr();
            const movieGroups = await this.groupManager.getMovieEnabledGroups();
            if (!movieGroups.length) {
                logger.info('Movie summary: no movie-enabled groups, skipping');
                return;
            }

            logger.info(`📊 Preparing daily summary for ${movieGroups.length} group(s)...`);
            
            let sent = 0;
            let skipped = 0;
            for (const group of movieGroups) {
                try {
                    const stats = await this.getDailySummaryStats(dateStr, group.group_id);
                    if (stats.totalSearches === 0) {
                        skipped++;
                        continue;
                    }
                    const text = formatDailySummary(stats);
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    logger.info(`✅ Summary posted to ${group.group_name || group.group_id} (${stats.totalSearches} searches)`);
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ Summary failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🎬 Daily movie summary: ${sent} sent, ${skipped} skipped (no activity), ${movieGroups.length} total`);
        } catch (err) {
            logger.error(`Movie daily summary error: ${err.message}`, err.stack);
        }
    }

    _getWeekDateRange() {
        const now = new Date();
        const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        const end = new Date(ist);
        end.setHours(23, 59, 59, 999);
        const start = new Date(ist);
        start.setDate(start.getDate() - 6);
        start.setHours(0, 0, 0, 0);

        const fmt = (d) => d.toISOString().split('T')[0];
        const label = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        return {
            startDate: fmt(start),
            endDate: fmt(end),
            weekLabel: `${label(start)} – ${label(end)}`,
        };
    }

    async _fetchTmdbTrending(limit = 10) {
        const key = config.TMDB_API_KEY;
        if (!key) return null;

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/trending/movie/week',
                { params: { api_key: key, language: 'en-US' }, timeout: 10000 }
            );
            const results = (data?.results || []).slice(0, limit);
            return results.map((m) => ({
                title: m.title || m.original_title,
                year: m.release_date?.split('-')[0] || '',
                rating: m.vote_average ? m.vote_average.toFixed(1) : '',
                plot: m.overview ? m.overview.slice(0, 120) + (m.overview.length > 120 ? '…' : '') : '',
            }));
        } catch (err) {
            logger.warn(`TMDB trending fetch failed: ${err.message}`);
            return null;
        }
    }

    async _getSearchBasedTrending(limit = 10) {
        const { startDate, endDate } = this._getWeekDateRange();
        const pipeline = [
            { $match: { date: { $gte: startDate, $lte: endDate }, result_count: { $gt: 0 } } },
            { $group: {
                _id: '$query_lower',
                query: { $first: '$query' },
                count: { $sum: 1 },
            }},
            { $sort: { count: -1 } },
            { $limit: limit },
        ];
        const results = await this.searchLog.aggregate(pipeline).toArray();
        return results.map((r) => ({ title: r.query, count: r.count }));
    }

    async getWeeklyTrending(limit = 10) {
        const { weekLabel } = this._getWeekDateRange();

        const tmdb = await this._fetchTmdbTrending(limit);
        if (tmdb?.length) {
            return { movies: tmdb, weekLabel, source: 'tmdb' };
        }

        const searched = await this._getSearchBasedTrending(limit);
        return { movies: searched, weekLabel, source: 'search' };
    }

    _scheduleWeeklyTrending() {
        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);

            const daysUntil = (WEEKLY_DAY - ist.getDay() + 7) % 7 || 7;
            target.setDate(target.getDate() + daysUntil);
            target.setHours(WEEKLY_HOUR, WEEKLY_MINUTE, 0, 0);

            if (target <= ist) target.setDate(target.getDate() + 7);

            const delayMs = target.getTime() - ist.getTime();
            const label = target.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
            logger.info(`🔥 Weekly trending scheduled for ${label} ${WEEKLY_HOUR}:${String(WEEKLY_MINUTE).padStart(2, '0')} IST (in ${Math.round(delayMs / 3600000)}h)`);

            this._weeklyTimer = setTimeout(async () => {
                await this._postWeeklyTrending();
                scheduleNext();
            }, delayMs);
        };
        scheduleNext();
    }

    async _postWeeklyTrending() {
        try {
            if (!this._sock) {
                logger.warn('Weekly trending: no socket available, skipping');
                return;
            }

            const trendingGroups = await this.groupManager.getWeeklyTrendingGroups();
            if (!trendingGroups.length) {
                logger.info('Weekly trending: no groups with trending enabled, skipping');
                return;
            }

            logger.info(`🔥 Preparing weekly trending for ${trendingGroups.length} group(s)...`);
            
            const { movies, weekLabel, source } = await this.getWeeklyTrending(10);
            
            if (!movies || movies.length === 0) {
                logger.warn('Weekly trending: no movies found, skipping post');
                return;
            }
            
            const text = formatWeeklyTrending(movies, weekLabel, source);
            logger.info(`🔥 Trending data ready: ${movies.length} movie(s) from ${source}`);

            let sent = 0;
            for (const group of trendingGroups) {
                try {
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    logger.info(`✅ Trending posted to ${group.group_name || group.group_id}`);
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ Trending failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🔥 Weekly trending posted to ${sent}/${trendingGroups.length} group(s)`);
        } catch (err) {
            logger.error(`Weekly trending error: ${err.message}`, err.stack);
        }
    }

    _scheduleWeeklyUpcoming() {
        const UPCOMING_DAY = 1; // Monday
        const UPCOMING_HOUR = 10;
        const UPCOMING_MINUTE = 0;

        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);

            const daysUntil = (UPCOMING_DAY - ist.getDay() + 7) % 7 || 7;
            target.setDate(target.getDate() + daysUntil);
            target.setHours(UPCOMING_HOUR, UPCOMING_MINUTE, 0, 0);

            if (target <= ist) target.setDate(target.getDate() + 7);

            const delayMs = target.getTime() - ist.getTime();
            const label = target.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
            logger.info(`🎬 Weekly upcoming scheduled for ${label} ${UPCOMING_HOUR}:${String(UPCOMING_MINUTE).padStart(2, '0')} IST (in ${Math.round(delayMs / 3600000)}h)`);

            this._upcomingTimer = setTimeout(async () => {
                await this._postWeeklyUpcoming();
                scheduleNext();
            }, delayMs);
        };
        scheduleNext();
    }

    async _postWeeklyUpcoming() {
        try {
            if (!this._sock) {
                logger.warn('Weekly upcoming: no socket available, skipping');
                return;
            }

            const movieGroups = await this.groupManager.getMovieEnabledGroups();
            if (!movieGroups.length) {
                logger.info('Weekly upcoming: no movie-enabled groups, skipping');
                return;
            }

            logger.info(`🎬 Preparing weekly upcoming for ${movieGroups.length} group(s)...`);
            
            const movies = await this._fetchUpcoming(8);
            if (!movies?.length) {
                logger.warn('Weekly upcoming: no upcoming movies found, skipping');
                return;
            }

            const now = new Date();
            const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
            const dateRange = `${now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} - ${twoWeeks.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
            const text = formatUpcomingMovies(movies, dateRange);
            
            logger.info(`🎬 Upcoming data ready: ${movies.length} movie(s)`);

            let sent = 0;
            for (const group of movieGroups) {
                try {
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    logger.info(`✅ Upcoming posted to ${group.group_name || group.group_id}`);
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ Upcoming failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🎬 Weekly upcoming posted to ${sent}/${movieGroups.length} group(s)`);
        } catch (err) {
            logger.error(`Weekly upcoming error: ${err.message}`, err.stack);
        }
    }

    getTodayDateStr() {
        const now = new Date();
        const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        return ist.toISOString().split('T')[0];
    }

    async getUserSearchCount(userId) {
        const normalizedUserId = normalizePhoneNumber(userId);
        const today = this.getTodayDateStr();
        const record = await this.searchLimits.findOne({ user_id: normalizedUserId, date: today });
        return record?.count || 0;
    }

    async incrementSearchCount(userId) {
        const normalizedUserId = normalizePhoneNumber(userId);
        const today = this.getTodayDateStr();
        await this.searchLimits.updateOne(
            { user_id: normalizedUserId, date: today },
            { $inc: { count: 1 }, $setOnInsert: { user_id: normalizedUserId, date: today } },
            { upsert: true }
        );
    }

    async adjustSearchCount(userId, amount, days = 1) {
        const normalizedUserId = normalizePhoneNumber(userId);
        const today = this.getTodayDateStr();
        const currentCount = await this.getUserSearchCount(normalizedUserId);
        const newCount = Math.max(0, currentCount - amount);
        
        // Update today's count
        await this.searchLimits.updateOne(
            { user_id: normalizedUserId, date: today },
            { $set: { count: newCount }, $setOnInsert: { user_id: normalizedUserId, date: today } },
            { upsert: true }
        );
        
        // Pre-set future days with negative count (extra searches)
        for (let i = 1; i < days; i++) {
            const futureDate = new Date(today + 'T00:00:00+05:30');
            futureDate.setDate(futureDate.getDate() + i);
            const futureDateStr = futureDate.toISOString().split('T')[0];
            
            await this.searchLimits.updateOne(
                { user_id: normalizedUserId, date: futureDateStr },
                { $set: { count: -amount }, $setOnInsert: { user_id: normalizedUserId, date: futureDateStr } },
                { upsert: true }
            );
        }
        
        return {
            previousUsed: currentCount,
            newUsed: newCount,
            previousRemaining: Math.max(0, DAILY_LIMIT - currentCount),
            newRemaining: Math.max(0, DAILY_LIMIT - newCount),
            days,
        };
    }

    async isUnlimitedUser(phoneNumber) {
        if (!this.groupManager) {
            return false;
        }

        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        if (!normalizedPhone) {
            return false;
        }

        const cached = this._unlimitedCache.get(normalizedPhone);
        if (cached && Date.now() - cached.at < 60_000) {
            return cached.unlimited;
        }

        const gm = this.groupManager;
        const [
            owner,
            moderator,
            dynamicMod,
            botAdmin,
            premium,
        ] = await Promise.all([
            Promise.resolve(gm.isOwner(normalizedPhone)),
            Promise.resolve(gm.isModerator(normalizedPhone)),
            gm.isDynamicModerator(normalizedPhone),
            gm.isBotAdmin(normalizedPhone),
            gm.isPremiumUser(normalizedPhone),
        ]);

        const unlimited = owner || moderator || dynamicMod || botAdmin || premium;
        if (this._unlimitedCache.size > 500) {
            this._unlimitedCache.delete(this._unlimitedCache.keys().next().value);
        }
        this._unlimitedCache.set(normalizedPhone, { unlimited, at: Date.now() });

        if (unlimited) {
            logger.debug(`✓ ${normalizedPhone} has unlimited movie searches`);
        }
        return unlimited;
    }

    async _notifySearchLog(sock, userId, query, resultCount, chatId, pushName) {
        try {
            const isGroup = chatId.endsWith('@g.us');
            let source = 'DM';

            if (isGroup && this.groupManager) {
                source = `📍 ${await this.groupManager.getGroupSubject(sock, chatId)}`;
            } else if (isGroup) {
                source = `📍 Group (${chatId.split('@')[0]})`;
            }
            
            const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
            const name = pushName || userId;
            const logJid = resolveNotificationJid(sock, [
                config.BOT_LOG_NUMBER,
                ...config.OWNER_NUMBERS,
            ]);
            if (!logJid) return;

            const text = `📋 *Search Log*\n`
                + `👤 ${name}\n`
                + `🔍 _${query}_\n`
                + `📊 ${resultCount} result(s)\n`
                + `${source}\n`
                + `🕐 ${time} IST`;
            await sock.sendMessage(logJid, { text });
        } catch (err) {
            logger.warn(`Search log notify failed: ${err.message}`);
        }
    }

    setSock(sock) {
        this._sock = sock;
    }

    scheduleDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
        if (!isGroupMessage(chatId)) return;

        this._activeDeleteTimers++;
        setTimeout(async () => {
            this._activeDeleteTimers--;
            try {
                await sock.sendMessage(chatId, { delete: messageKey });
                logger.info(`🗑️ Auto-deleted movie result in ${chatId}`);
            } catch (err) {
                logger.error(`Failed to auto-delete movie msg: ${err.message}`);
            }
        }, delayMs);
    }

    async _resolvePhoneNumber(sock, chatId, senderJid) {
        const direct = extractPhoneNumber(senderJid);
        if (direct && !senderJid?.includes('@lid')) return direct;

        if (senderJid?.includes('@lid') && chatId?.endsWith('@g.us') && this.groupManager) {
            try {
                const meta = await this.groupManager.getGroupMetadataCached(sock, chatId);
                for (const p of meta.participants || []) {
                    if (p.lid === senderJid || p.id === senderJid) {
                        const real = extractPhoneNumber(p.id || p.phoneNumber || p.pn || '');
                        if (real) return real;
                    }
                }
            } catch {}
        }
        return direct || senderJid;
    }

    _withTimeout(promise, ms, label = 'timeout') {
        return Promise.race([
            promise,
            new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
        ]);
    }

    /**
     * HDHub first; secondary sources only when needed or within a short grace window.
     */
    async _searchMovieSources(query, progress = null) {
        const hdTimeout = config.MOVIE_HD_TIMEOUT_MS || 28_000;
        const secTimeout = config.MOVIE_SECONDARY_TIMEOUT_MS || 8_000;
        const enrichGraceMs = 2_000;

        progress?.startPulse?.();
        await progress?.update?.({ percent: 15, vault: 'loading', hd: 'pending', drive: 'pending', atoz: 'pending' }, { force: true });

        // Our own Mkvbase vault API first — pinned above scraped sources in results.
        const vaultTimeout = config.MKVBASE_TIMEOUT_MS || 6_000;
        // Vault links are hubcloud/drive pages — bypass them into direct
        // server links (R2/10Gbps/FSLv2/FuckingFast) in the same parallel batch.
        const vaultBypassBudgetMs = config.MOVIE_HD_BYPASS_BUDGET_MS || 8_000;
        const vaultPromise = this._withTimeout(
            mkvbaseService
                .searchMovies(query, 10)
                .then((rows) => enrichResultsWithDirectLinks(rows, vaultBypassBudgetMs)),
            vaultTimeout + vaultBypassBudgetMs,
            'vault timeout',
        ).catch((err) => {
            logger.warn(`Mkvbase vault search failed for "${query}": ${err?.message || err}`);
            return [];
        });

        const hdPromise = this._withTimeout(
            hdHubMoviesService.searchMovies(query, 8),
            hdTimeout,
            'hdhub timeout',
        ).catch((err) => {
            logger.warn(`HDHub search failed for "${query}": ${err?.message || err}`);
            return [];
        });

        const drivePromise = this._withTimeout(
            pronoobDriveService.searchMovies(query, 5),
            secTimeout,
            'drive timeout',
        ).catch(() => []);

        const atozPromise = this._withTimeout(
            atozService.searchMovies(query, 3),
            secTimeout,
            'atoz timeout',
        ).catch(() => []);

        const hdResults = await hdPromise;
        const vaultResults = await vaultPromise;
        progress?.stopPulse?.();
        await progress?.flush?.({
            percent: 45,
            vault: 'done',
            vaultCount: vaultResults.length,
            hd: 'done',
            hdCount: hdResults.length,
            drive: 'loading',
            atoz: 'loading',
        });

        let driveResults = [];
        let atozResults = [];

        // Movies API already includes AtoZ with NullDrop mirrors — skip local scrape then
        const hdHasAtoz = hdResults.some((r) => /^atoz$/i.test(String(r?.source || '').trim()));

        if (hdResults.length >= 3) {
            [driveResults, atozResults] = await Promise.all([
                this._withTimeout(drivePromise, enrichGraceMs, 'drive grace').catch(() => []),
                hdHasAtoz
                    ? Promise.resolve([])
                    : this._withTimeout(atozPromise, enrichGraceMs, 'atoz grace').catch(() => []),
            ]);
        } else {
            [driveResults, atozResults] = await Promise.all([
                drivePromise,
                hdHasAtoz ? Promise.resolve([]) : atozPromise,
            ]);
        }

        if (hdHasAtoz && atozResults.length) {
            atozResults = [];
        }

        await progress?.flush?.({
            percent: 72,
            hd: 'done',
            hdCount: hdResults.length,
            drive: 'done',
            driveCount: driveResults.length,
            atoz: 'done',
            atozCount: atozResults.length,
        });

        return { vaultResults, hdResults, driveResults, atozResults };
    }

    async _fetchMovieResultsFromApis(query) {
        const { vaultResults, hdResults, driveResults, atozResults } = await this._searchMovieSources(query, null);

        let results = [];
        if (hdResults.length > 0) results.push(...hdResults);
        if (driveResults.length > 0) results.push(...driveResults);
        if (atozResults.length > 0) results.push(...atozResults);

        results = rankMovieResults(results, query);
        // Vault results always lead, regardless of relevance score (deduped by title).
        const seen = new Set(vaultResults.map((r) => cleanTitle(r.title).toLowerCase()));
        results = [...vaultResults, ...results.filter((r) => !seen.has(cleanTitle(r.title).toLowerCase()))];
        const sources = [...new Set(results.map((r) => r.source).filter(Boolean))];
        return { results, sources, hdResults, driveResults, atozResults };
    }

    _backgroundRefreshVault(query) {
        void movieCacheService.runBackgroundRefresh(query, async (q) => this._fetchMovieResultsFromApis(q));
    }

    async _getTopQueriesForPrewarm(limit = 20) {
        if (!this.searchLog) return [];

        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const rows = await this.searchLog.aggregate([
            { $match: { created_at: { $gte: weekAgo }, result_count: { $gt: 0 } } },
            { $group: { _id: '$query_lower', query: { $first: '$query' }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: limit },
        ]).toArray();

        return rows.map((r) => r.query).filter(Boolean);
    }

    async _runVaultPrewarm() {
        if (!movieCacheService.enabled() || config.MOVIE_CACHE_PREWARM_ENABLED === false) return;

        const topN = config.MOVIE_CACHE_PREWARM_TOP || 20;
        const queries = await this._getTopQueriesForPrewarm(topN);
        if (!queries.length) {
            logger.info('Movie vault pre-warm: no popular queries yet');
            return;
        }

        logger.info(`Movie vault pre-warm: refreshing top ${queries.length} queries…`);
        for (const query of queries) {
            const cached = await movieCacheService.lookup(query);
            if (cached?.fresh) continue;
            this._backgroundRefreshVault(query);
            await new Promise((r) => setTimeout(r, 2500));
        }
    }

    _scheduleVaultPrewarm() {
        if (config.MOVIE_CACHE_PREWARM_ENABLED === false) return;

        const hour = config.MOVIE_CACHE_PREWARM_HOUR ?? 3;
        const minute = config.MOVIE_CACHE_PREWARM_MINUTE ?? 30;

        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);
            target.setHours(hour, minute, 0, 0);
            if (target <= ist) target.setDate(target.getDate() + 1);

            const delayMs = target.getTime() - ist.getTime();
            logger.info(`🎬 Movie vault pre-warm at ${hour}:${String(minute).padStart(2, '0')} IST (in ${Math.round(delayMs / 60000)}m)`);

            this._prewarmTimer = setTimeout(async () => {
                await this._runVaultPrewarm();
                scheduleNext();
            }, delayMs);
        };

        scheduleNext();
    }

    /**
     * Fast path: any vault hit → serve instantly; refresh APIs in background when aging.
     */
    async _resolveMovieResults(query, progress) {
        const cached = await movieCacheService.lookup(query);

        if (cached?.results?.length) {
            const needsRefresh = movieCacheService.shouldRevalidate(cached);

            // Cache entries may predate vault-first ordering — re-pin ProNooB Drive on serve.
            const cacheResults = cloneMovieResults(cached.results);
            const vaultPinned = [
                ...cacheResults.filter((r) => String(r?.source || '') === 'ProNooB Drive'),
                ...cacheResults.filter((r) => String(r?.source || '') !== 'ProNooB Drive'),
            ];

            await progress.flush({
                percent: cached.fresh ? 75 : 68,
                cacheMode: true,
                resultCount: cacheResults.length,
                ageHours: cached.ageHours,
                staleCache: cached.stale,
                fuzzyMatch: cached.fuzzy,
                refreshing: needsRefresh,
            });

            void movieCacheService.recordHit(query);
            if (needsRefresh) {
                this._backgroundRefreshVault(query);
            }

            logger.info(
                `Movie vault HIT for "${query}" — ${cacheResults.length} title(s)`
                + `${cached.fuzzy ? ' (fuzzy)' : ''}${needsRefresh ? ' + bg refresh' : ''}`,
            );

            return {
                results: vaultPinned,
                sources: [...cached.sources, 'Vault'],
                servedFromCache: true,
                staleCache: cached.stale,
                fuzzyMatch: cached.fuzzy,
                hdResults: [],
                driveResults: [],
                atozResults: [],
            };
        }

        const { results, sources, hdResults, driveResults, atozResults } =
            await this._fetchMovieResultsFromApisWithProgress(query, progress);

        if (results.length > 0) {
            void movieCacheService.upsert(query, results, sources);
            return {
                results,
                sources,
                servedFromCache: false,
                staleCache: false,
                fuzzyMatch: false,
                hdResults,
                driveResults,
                atozResults,
            };
        }

        return {
            results: [],
            sources: [],
            servedFromCache: false,
            staleCache: false,
            fuzzyMatch: false,
            hdResults,
            driveResults,
            atozResults,
        };
    }

    async _fetchMovieResultsFromApisWithProgress(query, progress) {
        const { vaultResults, hdResults, driveResults, atozResults } = await this._searchMovieSources(query, progress);

        let results = [];
        if (hdResults.length > 0) results.push(...hdResults);
        if (driveResults.length > 0) results.push(...driveResults);
        if (atozResults.length > 0) results.push(...atozResults);

        results = rankMovieResults(results, query);
        // Vault results always lead, regardless of relevance score (deduped by title).
        const seen = new Set(vaultResults.map((r) => cleanTitle(r.title).toLowerCase()));
        results = [...vaultResults, ...results.filter((r) => !seen.has(cleanTitle(r.title).toLowerCase()))];
        const sources = [...new Set(results.map((r) => r.source).filter(Boolean))];
        return { results, sources, hdResults, driveResults, atozResults };
    }

    async handleMovieSearch(sock, chatId, senderJid, args, pushName = '', originalMsg = null) {
        const query = args.join(' ').trim();
        if (!query) {
            const usage = '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n'
                + '┃     🎬 *MOVIE SEARCH*      ┃\n'
                + '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n'
                + '*Usage:*  `/movie <name>`\n\n'
                + '*Examples:*\n'
                + '• `/movie Avengers`\n'
                + '• `/movie Pushpa 2`\n'
                + '• `/movie Interstellar`\n'
                + '• `/movie Animal`\n\n'
                + `📊 Daily limit: *${DAILY_LIMIT}* free searches\n`
                + '─────────────────────────────\n'
                + '_Search Bollywood, Hollywood & more!_ 🍿';
            await safeSendMessage(sock, chatId, { text: usage }, originalMsg);
            return;
        }

        return withMovieSearchLock(chatId, senderJid, async () => {
        const dialogue = getRandomDialogue(SEARCH_DIALOGUES);
        const initialProgress = formatMovieSearchProgress(dialogue, query, {
            percent: 10,
            vault: 'pending',
            hd: 'loading',
            drive: 'pending',
            atoz: 'pending',
        });
        const searchingMsgPromise = movieQuickSend(sock, chatId, { text: initialProgress }, originalMsg);

        const userId = await this._resolvePhoneNumber(sock, chatId, senderJid);
        const normalizedUserId = normalizePhoneNumber(userId);

        const unlimited = await this.isUnlimitedUser(userId);
        const currentCount = unlimited ? 0 : await this.getUserSearchCount(normalizedUserId);

        logger.info(`🎬 Movie search by ${userId} (normalized: ${normalizedUserId}): unlimited=${unlimited}, count=${currentCount}`);

        if (!unlimited && currentCount >= DAILY_LIMIT) {
            const searchingMsg = await searchingMsgPromise;
            await deleteMovieProgressMessage(sock, chatId, searchingMsg?.key);

            const limitMsg = formatLimitReached();
            const sent = await movieQuickSend(sock, chatId, { text: limitMsg }, originalMsg);
            this.scheduleDelete(sock, chatId, sent?.key);

            if (existsSync(QR_IMAGE_PATH)) {
                try {
                    const qrSent = await movieQuickSend(sock, chatId, {
                        image: readFileSync(QR_IMAGE_PATH),
                        caption: `💳 *Scan to pay for unlimited movie searches!*\n\nAfter payment, send screenshot to:\n📱 wa.me/${PAYMENT_CONTACT}`,
                    }, originalMsg);
                    this.scheduleDelete(sock, chatId, qrSent?.key);
                } catch (err) {
                    logger.error(`Failed to send QR image: ${err.message}`);
                }
            }
            return;
        }

        const remaining = unlimited ? '∞' : (DAILY_LIMIT - currentCount - 1);
        const searchingMsg = await searchingMsgPromise;
        const progress = makeMovieProgressEditor(sock, chatId, searchingMsg?.key, dialogue, query);

        try {
            const SHORTEN_BUDGET_MS = config.MOVIE_SHORTEN_BUDGET_MS || 15_000;

            const resolved = await this._resolveMovieResults(query, progress);
            let results = cloneMovieResults(resolved.results);
            const { hdResults, driveResults, atozResults, servedFromCache, staleCache, fuzzyMatch } = resolved;

            if (hdResults.length > 0) {
                logger.info(`HDHub: ${hdResults.length} results for "${query}"`);
            } else if (!servedFromCache) {
                logger.warn(`HDHub: no results for "${query}"`);
            }

            if (driveResults.length > 0) {
                logger.info(`Drive: ${driveResults.length} results for "${query}"`);
            }

            if (atozResults.length > 0) {
                logger.info(`AtoZ: ${atozResults.length} results for "${query}"`);
            }

            const sources = [...new Set(resolved.sources.filter(Boolean))];
            const cacheNote = servedFromCache
                ? (staleCache
                    ? '📦 _Instant vault — saved links (APIs slow/offline)_'
                    : fuzzyMatch
                        ? '📦 _Instant vault — fuzzy match_'
                        : '📦 _Instant vault — skipping APIs_')
                : '';

            if (!results?.length) {
                await progress.close();
                await deleteMovieProgressMessage(sock, chatId, searchingMsg?.key);

                const noResult = getRandomDialogue(NO_RESULTS_DIALOGUES);
                const noSent = await movieQuickSend(sock, chatId, { text: noResult, linkPreview: false }, originalMsg);
                this.scheduleDelete(sock, chatId, noSent.key);
                if (!unlimited) await this.incrementSearchCount(normalizedUserId);
                void this.logSearch(normalizedUserId, query, 0, chatId);
                void this._notifySearchLog(sock, normalizedUserId, query, 0, chatId, pushName);
                return;
            }

            if (!unlimited) await this.incrementSearchCount(normalizedUserId);
            await this.logSearch(normalizedUserId, query, results.length, chatId);
            try {
                const { botTelemetry } = await import('../utils/botTelemetry.js');
                botTelemetry.track('movie', {
                    query: query.slice(0, 80),
                    chatId,
                    results: results.length,
                });
            } catch {
                // ignore
            }

            if (!servedFromCache) {
                await progress.flush({
                    percent: 82,
                    hd: 'done',
                    hdCount: hdResults.length,
                    drive: 'done',
                    driveCount: driveResults.length,
                    atoz: 'done',
                    atozCount: atozResults.length,
                });
            }

            try {
                await progress.flush(servedFromCache
                    ? { percent: 88, cacheMode: true, resultCount: results.length, shorten: 'loading' }
                    : {
                        percent: 90,
                        hd: 'done',
                        hdCount: hdResults.length,
                        drive: 'done',
                        driveCount: driveResults.length,
                        atoz: 'done',
                        atozCount: atozResults.length,
                        shorten: 'loading',
                    });

                await Promise.race([
                    urlShortener.shortenMovieResults(results, SHORTEN_BUDGET_MS),
                    new Promise((resolve) => {
                        setTimeout(() => {
                            logger.warn(`URL shorten cap (${SHORTEN_BUDGET_MS}ms) — sending with available short links`);
                            resolve(results);
                        }, SHORTEN_BUDGET_MS);
                    }),
                ]);
            } catch (err) {
                logger.warn(`URL shorten skipped (sending results anyway): ${err?.message || err}`);
            }

            const resultMessages = formatMovieResults(query, results, pushName, sources, { cacheNote });
            logger.info(`Formatted ${resultMessages.length} message(s) for "${query}" (${resultMessages.reduce((a, m) => a + m.length, 0)} chars)`);

            if (!resultMessages.length) {
                await progress.close();
                await deleteMovieProgressMessage(sock, chatId, searchingMsg?.key);
                const errSent = await movieQuickSend(sock, chatId, {
                    text: '⚠️ Found movies but could not format results. Try again.',
                }, originalMsg);
                this.scheduleDelete(sock, chatId, errSent.key);
                return;
            }

            await progress.close();
            await deleteMovieProgressMessage(sock, chatId, searchingMsg?.key);

            const footer = unlimited
                ? '\n\n⭐ _Unlimited searches (Premium/Staff)_'
                : `\n\n🔢 _Searches left today: *${remaining}* / ${DAILY_LIMIT}_`;

            let sentCount = 0;
            for (let i = 0; i < resultMessages.length; i++) {
                let text = resultMessages[i];
                if (i === resultMessages.length - 1) {
                    text += footer;
                }

                try {
                    logger.info(`Sending movie result part ${i + 1}/${resultMessages.length} (${text.length} chars) to ${chatId}...`);
                    let sent = await movieResultSend(sock, chatId, { text, linkPreview: false }, originalMsg);
                    if (!sent?.key && originalMsg) {
                        sent = await safeSendMessage(
                            sock,
                            chatId,
                            { text, linkPreview: false },
                            originalMsg,
                            { queuePriority: MOVIE_RESULT_PRIORITY },
                        );
                    }
                    logger.info(`Sent movie result part ${i + 1} OK`);

                    if (sent?.key) {
                        sentCount++;
                        this.scheduleDelete(sock, chatId, sent.key);
                    }

                    if (i < resultMessages.length - 1) {
                        // Yield so other chats/commands can run between parts
                        await new Promise((r) => setImmediate(r));
                        await new Promise((r) => setTimeout(r, 120));
                    }
                } catch (sendErr) {
                    logger.error(`Movie result send failed (part ${i + 1}/${resultMessages.length}): ${sendErr.stack || sendErr.message}`);
                    if (sentCount === 0) {
                        throw sendErr;
                    }
                }
            }

            logger.info(`🎬 Movie search "${query}" by ${userId} → ${results.length} results from [${sources.join(', ')}] (${sentCount}/${resultMessages.length} msg(s), ${remaining} left)`);
            void this._notifySearchLog(sock, normalizedUserId, query, results.length, chatId, pushName);
        } catch (err) {
            await progress?.close?.();
            await deleteMovieProgressMessage(sock, chatId, searchingMsg?.key);

            const errorDialogues = [
                "🎭 _\"Technical difficulties... even JARVIS needs a break!\"_\n\n⚠️ Search failed. Try again in a moment!",
                "🎭 _\"Server ne haath khade kar diye!\"_\n\n⚠️ Couldn't reach the movie database. Try again!",
                "🎭 _\"Not even Doctor Strange saw this error coming...\"_\n\n⚠️ Something went wrong. Try later!",
            ];
            const errSent = await movieQuickSend(sock, chatId, {
                text: getRandomDialogue(errorDialogues),
            }, originalMsg);
            this.scheduleDelete(sock, chatId, errSent.key);

            logger.error(`Movie search error for "${query}": ${err.stack || err.message}`);
        }
        });
    }

    async handleUpcoming(sock, chatId, senderJid, originalMsg = null) {
        try {
            const movies = await this._fetchUpcoming(10);
            if (!movies) {
                await safeSendMessage(sock, chatId, { text: '⚠️ Could not fetch upcoming movies. TMDB API may be unavailable.' }, originalMsg);
                return;
            }

            const now = new Date();
            const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
            const dateRange = `${now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} - ${twoWeeks.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

            const text = formatUpcomingMovies(movies, dateRange);
            await safeSendMessage(sock, chatId, { text }, originalMsg);
            logger.info(`🎬 Upcoming movies sent to ${chatId}`);
        } catch (err) {
            logger.error(`Upcoming movies error: ${err.message}`);
            await safeSendMessage(sock, chatId, { text: '⚠️ Failed to fetch upcoming movies.' }, originalMsg);
        }
    }

    async handleGenre(sock, chatId, senderJid, args, originalMsg = null) {
        const genreName = (args[0] || '').toLowerCase();

        if (!genreName || !TMDB_GENRES[genreName]) {
            const available = Object.keys(TMDB_GENRES).filter(g => g !== 'sci-fi').join(', ');
            await safeSendMessage(sock, chatId, {
                text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    + '🎭 *GENRE RECOMMENDATIONS*\n'
                    + '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
                    + '*Usage:* `/genre <name>`\n\n'
                    + '*Available genres:*\n'
                    + `${available}\n\n`
                    + '*Examples:*\n'
                    + '• `/genre action`\n'
                    + '• `/recommend horror`\n'
                    + '• `/genre comedy`',
            }, originalMsg);
            return;
        }

        try {
            const movies = await this._fetchGenreMovies(genreName, 10);
            if (!movies) {
                await safeSendMessage(sock, chatId, { text: '⚠️ Could not fetch genre movies. TMDB API may be unavailable.' }, originalMsg);
                return;
            }

            const text = formatGenreMovies(genreName, movies);
            await safeSendMessage(sock, chatId, { text }, originalMsg);
            logger.info(`🎭 Genre "${genreName}" sent to ${chatId}`);
        } catch (err) {
            logger.error(`Genre movies error: ${err.message}`);
            await safeSendMessage(sock, chatId, { text: '⚠️ Failed to fetch genre movies.' }, originalMsg);
        }
    }

    async _fetchUpcoming(limit = 10) {
        const key = config.TMDB_API_KEY;
        if (!key) return null;

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/movie/upcoming',
                { params: { api_key: key, language: 'en-US', region: 'IN' }, timeout: 10000 }
            );
            const genreMap = await this._getGenreMap();
            const results = await this._enrichTmdbMovies((data?.results || []).slice(0, limit));
            return results.map((m) => ({
                title: m.title || m.original_title,
                releaseDate: m.release_date ? new Date(m.release_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBA',
                genres: (m.genre_ids || []).map(id => genreMap[id] || '').filter(Boolean).join(', ') || 'N/A',
                cast: m.cast || '',
                plot: m.overview || '',
            }));
        } catch (err) {
            logger.warn(`TMDB upcoming fetch failed: ${err.message}`);
            return null;
        }
    }

    async _fetchGenreMovies(genreName, limit = 10) {
        const key = config.TMDB_API_KEY;
        if (!key) return null;

        const genreId = TMDB_GENRES[genreName];
        if (!genreId) return null;

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/discover/movie',
                {
                    params: {
                        api_key: key,
                        language: 'en-US',
                        sort_by: 'popularity.desc',
                        with_genres: genreId,
                        'vote_count.gte': 50,
                    },
                    timeout: 10000,
                }
            );
            const results = await this._enrichTmdbMovies((data?.results || []).slice(0, limit));
            return results.map((m) => ({
                title: m.title || m.original_title,
                year: m.release_date?.split('-')[0] || '',
                rating: m.vote_average ? m.vote_average.toFixed(1) : '',
                cast: m.cast || '',
                plot: m.overview || '',
            }));
        } catch (err) {
            logger.warn(`TMDB genre fetch failed: ${err.message}`);
            return null;
        }
    }

    async _enrichTmdbMovies(movies = []) {
        const key = config.TMDB_API_KEY;
        if (!key || !movies.length) return movies;

        const enriched = await Promise.all(movies.map(async (movie) => {
            if (!movie?.id) return movie;

            try {
                const { data } = await axios.get(
                    `https://api.themoviedb.org/3/movie/${movie.id}`,
                    {
                        params: {
                            api_key: key,
                            language: 'en-US',
                            append_to_response: 'credits',
                        },
                        timeout: 10000,
                    }
                );

                const cast = (data?.credits?.cast || [])
                    .slice(0, 5)
                    .map((actor) => actor.name)
                    .filter(Boolean)
                    .join(', ');

                return {
                    ...movie,
                    overview: data?.overview || movie.overview || '',
                    cast,
                };
            } catch (err) {
                logger.warn(`TMDB details fetch failed for ${movie.title || movie.id}: ${err.message}`);
                return movie;
            }
        }));

        return enriched;
    }

    async _getGenreMap() {
        if (this._genreCache) return this._genreCache;
        const key = config.TMDB_API_KEY;
        if (!key) return {};

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/genre/movie/list',
                { params: { api_key: key, language: 'en-US' }, timeout: 10000 }
            );
            this._genreCache = {};
            for (const g of (data?.genres || [])) {
                this._genreCache[g.id] = g.name;
            }
            return this._genreCache;
        } catch (err) {
            logger.warn(`TMDB genre list fetch failed: ${err.message}`);
            return {};
        }
    }

    _scheduleExpireLimitAlerts() {
        // Check for bonus limits expiring tomorrow, every hour at :00
        const checkAlerts = async () => {
            try {
                const now = new Date();
                const tomorrowStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                tomorrowStart.setHours(0, 0, 0, 0);
                const tomorrowStr = tomorrowStart.toISOString().split('T')[0];

                // Find all records with negative count (bonus searches) expiring tomorrow
                const expiringLimits = await this.searchLimits.find({ count: { $lt: 0 }, date: tomorrowStr }).toArray();
                
                if (!expiringLimits.length) return;

                for (const limit of expiringLimits) {
                    const userId = limit.user_id;
                    const bonusAmount = -limit.count;
                    
                    try {
                        // Send to group if possible, DM as fallback
                        const dmText = `⏰ *Bonus Search Expiring Soon*\n\n`
                            + `⚠️ Your *${bonusAmount} bonus search(es)* expire tomorrow!\n\n`
                            + `Use them today or you'll lose them. ⏳`;
                        
                        if (!this.sock) return;
                        await this.sock.sendMessage(`${userId}@s.whatsapp.net`, { text: dmText });
                    } catch (err) {
                        logger.warn(`Failed to send expiry alert to ${userId}: ${err.message}`);
                    }
                }
            } catch (err) {
                logger.error(`Error checking expire limits: ${err.message}`);
            }
        };

        checkAlerts();
        setInterval(checkAlerts, 60 * 60 * 1000); // Check hourly
    }
}

export default MovieController;
