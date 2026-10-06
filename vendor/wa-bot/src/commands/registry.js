/**
 * Command registry — single place for names, where they work, and who can run them.
 *
 * scope:
 *   - any          → DM and groups
 *   - group_only   → WhatsApp groups (@g.us) only
 *   - dm_only      → direct chats only
 *
 * role:
 *   - anyone       → any member / any DM user
 *   - staff        → owners, moderators (.env), DB admins, or WhatsApp group admins
 *   - admins           → owners, bot admins, or WhatsApp group admins in that group (auto-detected)
 *   - admin_managers   → owners, moderators, or bot admins (manage /addadmin /removeadmin)
 *   - welcome_setters  → admins or admin_managers (set group welcome messages)
 */

/** @typedef {'any' | 'group_only' | 'dm_only'} ChatScope */
/** @typedef {'anyone' | 'staff' | 'admins' | 'admin_managers' | 'welcome_setters' | 'owner'} Role */

/**
 * @typedef {object} CommandDefinition
 * @property {string[]} names       Primary name first; aliases after (e.g. ['/insta','/i'])
 * @property {string} key           Stable id for dispatch
 * @property {ChatScope} scope
 * @property {Role} role
 * @property {string} help          One line for /help
 */

/** @type {CommandDefinition[]} */
export const COMMAND_REGISTRY = [
    {
        names: ['/ping', '/a', '/alive'],
        key: 'ping',
        scope: 'any',
        role: 'anyone',
        help: 'Check if bot is alive',
    },
    {
        names: ['/help'],
        key: 'help',
        scope: 'any',
        role: 'anyone',
        help: 'Show this list',
    },
    {
        names: ['/facts'],
        key: 'facts',
        scope: 'group_only',
        role: 'anyone',
        help: 'Random fun fact (groups only)',
    },
    {
        names: ['/insta', '/i'],
        key: 'insta',
        scope: 'any',
        role: 'anyone',
        help: 'Download Instagram post/reel; auto in DMs & groups with `/instaon`',
    },
    {
        names: ['/tw', '/twitter'],
        key: 'tw',
        scope: 'any',
        role: 'anyone',
        help: 'Download Twitter/X video — `/tw <link>`',
    },
    {
        names: ['/movie', '/m', '/search', '/s'],
        key: 'movie',
        scope: 'any',
        role: 'anyone',
        help: 'Search & download movies (5/day free)',
        category: 'movie',
    },
    {
        names: ['/upcoming'],
        key: 'upcoming',
        scope: 'any',
        role: 'anyone',
        help: 'Upcoming movies releasing soon (from TMDB)',
        category: 'movie',
    },
    {
        names: ['/genre', '/recommend'],
        key: 'genre',
        scope: 'any',
        role: 'anyone',
        help: 'Top movies by genre (action, horror, comedy, etc)',
        category: 'movie',
    },
    {
        names: ['/sticker', '/stk'],
        key: 'sticker',
        scope: 'any',
        role: 'anyone',
        help: 'Create sticker from image/video (reply; options: circle/c, crop, pack, author, nometadata)',
    },
    {
        names: ['/steal'],
        key: 'steal',
        scope: 'any',
        role: 'anyone',
        help: 'Steal sticker — change metadata or make circular (reply; options: circle/c, pack, author)',
    },
    {
        names: ['/toimg', '/image'],
        key: 'toimg',
        scope: 'any',
        role: 'anyone',
        help: 'Convert sticker to image (reply to sticker)',
    },
    {
        names: ['/rgb'],
        key: 'rgb',
        scope: 'any',
        role: 'anyone',
        help: 'Animated rainbow/RGB text sticker — `/rgb Your Text`',
    },
    {
        names: ['/tgstickers', '/tgsticker', '/tgstk'],
        key: 'tgstickers',
        scope: 'any',
        role: 'admins',
        help: 'Import Telegram sticker pack — `/tgstickers <t.me/addstickers/PackName or just PackName>` (admins)',
    },
    {
        names: ['/tgstop'],
        key: 'tgstop',
        scope: 'any',
        role: 'admins',
        help: 'Cancel an ongoing Telegram sticker import (admins)',
    },
    {
        names: ['/tgstickeron'],
        key: 'tgstickeron',
        scope: 'group_only',
        role: 'owner',
        help: 'Enable /tgstickers import in this group (owner only)',
    },
    {
        names: ['/tgstickeroff'],
        key: 'tgstickeroff',
        scope: 'group_only',
        role: 'owner',
        help: 'Disable /tgstickers import in this group (owner only)',
    },
    {
        names: ['/news'],
        key: 'news',
        scope: 'any',
        role: 'anyone',
        help: 'Preview 10 tech news items; staff post to news-enabled groups',
    },
    {
        names: ['/github'],
        key: 'github',
        scope: 'any',
        role: 'anyone',
        help: 'Preview GitHub repos; staff reply yes/no to post to github-enabled groups',
    },
    {
        names: ['/awesome'],
        key: 'awesome',
        scope: 'any',
        role: 'anyone',
        help: 'Preview awesome-* lists; staff reply yes/no to post to awesome-enabled groups',
    },
    {
        names: ['/horo', '/horoscope'],
        key: 'horo',
        scope: 'any',
        role: 'anyone',
        help: 'Daily horoscope — `/horo capricorn` or `/horo cap`',
    },
    {
        names: ['/advice'],
        key: 'advice',
        scope: 'any',
        role: 'anyone',
        help: 'Random advice from AdviceSlip API',
    },
    {
        names: ['/posted'],
        key: 'posted',
        scope: 'any',
        role: 'anyone',
        help: 'Course statistics for this chat',
    },
    {
        names: ['/status'],
        key: 'status',
        scope: 'any',
        role: 'anyone',
        help: 'Bot status and posting stats',
    },
    {
        names: ['/activate'],
        key: 'activate',
        scope: 'group_only',
        role: 'staff',
        help: 'Turn on courses in this group (staff only)',
    },
    {
        names: ['/deactivate'],
        key: 'deactivate',
        scope: 'group_only',
        role: 'staff',
        help: 'Turn off courses + tech news in this group (staff only)',
    },
    {
        names: ['/newson'],
        key: 'newson',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable scheduled tech news in this group',
    },
    {
        names: ['/newsoff'],
        key: 'newsoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable tech news only — use /coursesoff for courses',
    },
    {
        names: ['/courson', '/courseson'],
        key: 'courson',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable automatic course posting in this group',
    },
    {
        names: ['/coursesoff', '/courseoff'],
        key: 'coursesoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable courses in this group — news can stay on',
    },
    {
        names: ['/githubon'],
        key: 'githubon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable daily GitHub trending repos in this group',
    },
    {
        names: ['/githuboff'],
        key: 'githuboff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable GitHub trending only — courses continue',
    },
    {
        names: ['/autochat'],
        key: 'autochat',
        scope: 'group_only',
        role: 'staff',
        help: 'Auto open 9 AM & lock at 11:55 PM daily — /autochat on|off|status',
    },
    {
        names: ['/awesomeon'],
        key: 'awesomeon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable daily awesome-list posts in this group',
    },
    {
        names: ['/awesomeoff'],
        key: 'awesomeoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable awesome lists only — GitHub continues',
    },
    {
        names: ['/interviewqon'],
        key: 'interviewqon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable Interview Q polls (3×/day Medium/Hard) + Sat weekly leaderboard/recap',
    },
    {
        names: ['/interviewqoff'],
        key: 'interviewqoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable Interview Q polls in this group',
    },
    {
        names: ['/aiupdateson'],
        key: 'aiupdateson',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable daily AI updates (tools, India AI news, model releases) in this group',
    },
    {
        names: ['/aiupdatesoff'],
        key: 'aiupdatesoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable AI updates in this group',
    },
    {
        names: ['/interviewq'],
        key: 'interviewq',
        scope: 'any',
        role: 'admins',
        help: 'Interview Q: `/interviewq test|post|answer|board`',
    },
    {
        names: ['/iqboard'],
        key: 'iqboard',
        scope: 'any',
        role: 'anyone',
        help: 'Weekly Interview Q leaderboard for this chat',
        category: 'daily',
    },
    {
        names: ['/tagme'],
        key: 'tagme',
        scope: 'group_only',
        role: 'anyone',
        help: 'Get tagged in Interview Q posts & leaderboards in this group',
        category: 'daily',
    },
    {
        names: ['/notag'],
        key: 'notag',
        scope: 'group_only',
        role: 'anyone',
        help: 'Stop being tagged in Interview Q posts in this group',
        category: 'daily',
    },
    {
        names: ['/checktagstatus', '/tagstatus', '/tagcheck'],
        key: 'checktagstatus',
        scope: 'group_only',
        role: 'anyone',
        help: 'Check your Interview Q tag ON/OFF status and who is opted in',
        category: 'daily',
    },
    {
        names: ['/roast'],
        key: 'roast',
        scope: 'any',
        role: 'anyone',
        help: 'AI resume roast — send a resume PDF with /roast as caption',
        category: 'resume',
    },
    {
        names: ['/birthday'],
        key: 'birthday',
        scope: 'group_only',
        role: 'anyone',
        help: 'Save your birthday (add DD-MM) — get an AI wish + tag on your day',
        category: 'fun',
    },
    {
        names: ['/bypass'],
        key: 'bypass',
        scope: 'any',
        role: 'anyone',
        help: 'Bypass HDHub4u/HubCloud/GDFlix link to direct download links (3/day free)',
        category: 'movie',
    },
    {
        names: ['/bypasson'],
        key: 'bypasson',
        scope: 'group_only',
        role: 'staff',
        help: 'Auto-bypass HDHub4u/HubCloud/GDFlix links pasted in this group',
    },
    {
        names: ['/bypassoff'],
        key: 'bypassoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Stop auto-bypass in this group',
    },
    {
        names: ['/instaon'],
        key: 'instaon',
        scope: 'group_only',
        role: 'staff',
        help: 'Auto-download Instagram links pasted in this group',
    },
    {
        names: ['/instaoff'],
        key: 'instaoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Stop auto Instagram download in this group',
    },
    {
        names: ['/stickeron'],
        key: 'stickeron',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable auto sticker forwarding into this group (from channels/source groups)',
    },
    {
        names: ['/stickeroff'],
        key: 'stickeroff',
        scope: 'group_only',
        role: 'staff',
        help: 'Stop auto sticker forwarding into this group',
    },
    {
        names: ['/setwc'],
        key: 'setwc',
        scope: 'group_only',
        role: 'welcome_setters',
        help: 'Set welcome extra line; auto-deletes after 2 min — `/setwc on` to enable',
    },
    {
        names: ['/link', '/gclink', '/getlink'],
        key: 'link',
        scope: 'group_only',
        role: 'anyone',
        help: 'Get this group\'s invite link — admins refresh it, members get the saved link',
    },
    {
        names: ['/revokelink', '/revoke'],
        key: 'revokelink',
        scope: 'group_only',
        role: 'admins',
        help: 'Revoke & regenerate this group\'s invite link (admins only)',
    },
    {
        names: ['/warn'],
        key: 'warn',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Warn a member (reply/@tag/phone) + reason — auto-kick at 5 warns',
    },
    {
        names: ['/mywarns'],
        key: 'mywarns',
        scope: 'group_only',
        help: 'View your warnings and reasons in this group',
    },
    {
        names: ['/warns'],
        key: 'warns',
        scope: 'group_only',
        role: 'group_admins',
        help: 'View a member\'s warnings (reply/@tag/phone)',
    },
    {
        names: ['/clearwarns'],
        key: 'clearwarns',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Clear all warnings for a member (reply/@tag/phone)',
    },
    {
        names: ['/kick', '/remove'],
        key: 'kick',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Remove a member (reply/@tag/phone) — they can rejoin later',
    },
    {
        names: ['/ban'],
        key: 'ban',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Kick + blacklist a member (reply/@tag/phone) — auto-removed if they rejoin',
    },
    {
        names: ['/unban'],
        key: 'unban',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Remove a member from this group\'s ban list (reply/@tag/phone)',
    },
    {
        names: ['/banlist'],
        key: 'banlist',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Show this group\'s banned members',
    },
    {
        names: ['/dellast', '/del'],
        key: 'dellast',
        scope: 'group_only',
        role: 'admins',
        help: 'Delete recent tracked messages — `/dellast <n>` (most recent N), `/delall`, reply + `/del`',
    },
    {
        names: ['/delall'],
        key: 'delall',
        scope: 'group_only',
        role: 'admins',
        help: 'Delete all tracked messages in group (up to 500)',
    },
    {
        names: ['/groups'],
        key: 'groups',
        scope: 'any',
        role: 'admins',
        help: 'List courses-active & insta-auto groups with member counts',
    },
    {
        names: ['/pause'],
        key: 'pause',
        scope: 'any',
        role: 'admins',
        help: 'Pause automatic course posting only (tech news continues)',
    },
    {
        names: ['/resumecourses', '/unpausecourses'],
        key: 'resumecourses',
        scope: 'any',
        role: 'admins',
        help: 'Resume automatic course posting (after `/pause`)',
    },
    {
        names: ['/clear'],
        key: 'clear',
        scope: 'any',
        role: 'admins',
        help: 'Start deleting posted courses for this chat (needs /confirm)',
    },
    {
        names: ['/confirm'],
        key: 'confirm',
        scope: 'any',
        role: 'admins',
        help: 'Confirm /clear',
    },
    {
        names: ['/cancel'],
        key: 'cancel',
        scope: 'any',
        role: 'admins',
        help: 'Cancel pending /clear',
    },
    {
        names: ['/addadmin'],
        key: 'addadmin',
        scope: 'any',
        role: 'admin_managers',
        help: 'Add bot admin (phone, @tag, or reply)',
    },
    {
        names: ['/removeadmin'],
        key: 'removeadmin',
        scope: 'any',
        role: 'admin_managers',
        help: 'Remove bot admin (phone, @tag, or reply)',
    },
    {
        names: ['/admins'],
        key: 'admins',
        scope: 'any',
        role: 'admins',
        help: 'List bot staff + WhatsApp group admins',
    },
    {
        names: ['/movieon'],
        key: 'movieon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable movie search + daily recap in this group',
        category: 'movie',
    },
    {
        names: ['/movieoff'],
        key: 'movieoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable movie features in this group',
        category: 'movie',
    },
    {
        names: ['/summaryon'],
        key: 'summaryon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable daily end-of-day group chat recap in this group',
        category: 'movie',
    },
    {
        names: ['/summaryoff'],
        key: 'summaryoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable daily group chat recap in this group',
        category: 'movie',
    },
    {
        names: ['/summarynow'],
        key: 'summarynow',
        scope: 'group_only',
        role: 'admins',
        help: 'Send group recap now for yesterday (owners / bot admins / group admins)',
        category: 'movie',
    },
    {
        names: ['/assist'],
        key: 'assist',
        scope: 'any',
        role: 'owner',
        help: 'DM assistant — `/assist on` replies as Jacky in personal chats (Gemini)',
        category: 'owner',
    },
    {
        names: ['/trending'],
        key: 'trending',
        scope: 'group_only',
        role: 'staff',
        help: 'Toggle weekly trending movies — `/trending on` or `/trending off`',
        category: 'movie',
    },
    {
        names: ['/tradelert'],
        key: 'tradelert',
        scope: 'group_only',
        role: 'staff',
        help: 'Daily F&O alerts — `/tradelert on`, `source heatmap2|heatmap|nse|legacy`, `scan`, `stats`',
        category: 'trade',
    },
    {
        names: ['/tradenow'],
        key: 'tradenow',
        scope: 'group_only',
        role: 'admins',
        help: 'Indian options analysis — `/tradenow RELIANCE`',
        category: 'trade',
    },
    {
        names: ['/index'],
        key: 'index',
        scope: 'group_only',
        role: 'admins',
        help: 'Index F&O read — `/index nifty`, `/index banknifty` (OI walls · PCR · max pain · ATM)',
        category: 'trade',
    },
    {
        names: ['/chainai'],
        key: 'chainai',
        scope: 'group_only',
        role: 'admins',
        help: 'AI option chain analysis — `/chainai nifty` (IV skew · OI walls · PCR · unusual activity · strategy)',
        category: 'trade',
    },
    {
        names: ['/svmkr', '/ut'],
        key: 'svmkr',
        scope: 'group_only',
        role: 'admins',
        help: 'SVMKR live CE/PE alerts — `/svmkr on|off|status`, `/svmkr` (read now), `/svmkr stats`, `/svmkr scan`',
        category: 'trade',
    },
    {
        names: ['/expiry'],
        key: 'expiry',
        scope: 'group_only',
        role: 'admins',
        help: 'Expiry-day index options — `/expiry`, `/expiry nifty`, `/expiry nifty hero`',
        category: 'trade',
    },
    {
        names: ['/swing'],
        key: 'swing',
        scope: 'group_only',
        role: 'admins',
        help: 'Swing setups — momentum rank + 52w breakout — `/swing`, `/swing top`',
        category: 'trade',
    },
    {
        names: ['/backtest'],
        key: 'backtest',
        scope: 'any',
        role: 'admins',
        help: 'NIFTY backtest — `/backtest`, `/backtest 30` (days)',
        category: 'trade',
    },
    {
        names: ['/scalp'],
        key: 'scalp',
        scope: 'group_only',
        role: 'admins',
        help: 'Micro scalp card — `/scalp`, `/scalp sensex`, `/scalp alert nifty sensex`',
        category: 'trade',
    },
    {
        names: ['/sweep'],
        key: 'sweep',
        scope: 'group_only',
        role: 'admins',
        help: 'Liquidity sweep now — `/sweep`, `/sweep NIFTY`, `/sweep SENSEX`',
        category: 'trade',
    },
    {
        names: ['/scalpon'],
        key: 'scalpon',
        scope: 'group_only',
        role: 'owner',
        help: 'Enable scalp alerts here — `/scalpon nifty sensex` (owner only)',
        category: 'trade',
    },
    {
        names: ['/scalpoff'],
        key: 'scalpoff',
        scope: 'group_only',
        role: 'owner',
        help: 'Disable /scalp in this group (owner only)',
        category: 'trade',
    },
    {
        names: ['/addpremium'],
        key: 'addpremium',
        scope: 'any',
        role: 'owner',
        help: 'Grant premium (unlimited movies) — phone, @tag, or reply',
        category: 'movie',
    },
    {
        names: ['/removepremium', '/rmpremium'],
        key: 'removepremium',
        scope: 'any',
        role: 'owner',
        help: 'Revoke premium — phone, @tag, or reply',
        category: 'movie',
    },
    {
        names: ['/premium'],
        key: 'premium',
        scope: 'any',
        role: 'owner',
        help: 'List all premium users',
        category: 'movie',
    },
    {
        names: ['/increaselimit', '/addlimit'],
        key: 'increaselimit',
        scope: 'any',
        role: 'admins',
        help: 'Add searches to user — `/increaselimit 5` or `/increaselimit 5 3d` (reply/@tag)',
        category: 'movie',
    },
    {
        names: ['/checklimit', '/mylimit'],
        key: 'checklimit',
        scope: 'any',
        role: 'anyone',
        help: 'Check movie search limit — yours or tag/reply (admins only)',
        category: 'movie',
    },
    {
        names: ['/addmod'],
        key: 'addmod',
        scope: 'any',
        role: 'owner',
        help: 'Add moderator — phone, @tag, or reply',
    },
    {
        names: ['/removemod', '/rmmod'],
        key: 'removemod',
        scope: 'any',
        role: 'owner',
        help: 'Remove moderator — phone, @tag, or reply',
    },
    {
        names: ['/addchannel'],
        key: 'addchannel',
        scope: 'any',
        role: 'owner',
        help: 'Add sticker source channel (owner only)',
    },
    {
        names: ['/removechannel', '/rmchannel'],
        key: 'removechannel',
        scope: 'any',
        role: 'owner',
        help: 'Remove sticker source channel (owner only)',
    },
    {
        names: ['/channels'],
        key: 'channels',
        scope: 'any',
        role: 'owner',
        help: 'List sticker source channels (owner only)',
    },
    {
        names: ['/grouppost', '/groupmsg'],
        key: 'grouppost',
        scope: 'any',
        role: 'owner',
        help: 'Post in group(s) — multiline/reply supported — `/grouppost <#> <msg>` or `/grouppost all <msg>` (owner only)',
    },
    {
        names: ['/driveurl', '/drivesource'],
        key: 'driveurl',
        scope: 'any',
        role: 'owner',
        help: 'Manage Drive scrape URLs — add/remove/list/test Render sources (owner only)',
        category: 'movie',
    },
    {
        names: ['/vv', '/viewonce'],
        key: 'viewonce',
        scope: 'any',
        role: 'anyone',
        help: 'Reply to a view-once message to reveal it (groups + DMs)',
    },
    {
        names: ['/deploy', '/redeploy'],
        key: 'deploy',
        scope: 'any',
        role: 'owner',
        help: 'Trigger redeploy on Render or Koyeb (owner only)',
    },
    {
        names: ['/cmdlog'],
        key: 'cmdlog',
        scope: 'any',
        role: 'owner',
        help: 'Recent command usage — who, what, where (owner only)',
    },
    {
        names: ['/ipo'],
        key: 'ipo',
        scope: 'any',
        role: 'anyone',
        help: 'Indian IPO analysis — `/ipo` list, `/ipo <name>` AI analysis, `/ipo gmp` leaderboard',
        category: 'trade',
    },
    {
        names: ['/resume', '/cv', '/setcv', '/mycv'],
        key: 'resume',
        scope: 'any',
        role: 'anyone',
        help: 'Tailor resume to a JD — upload → JD → Exact/Related → TXT or PDF output',
        category: 'resume',
    },
    {
        names: ['/tailor', '/tailorcv', '/jd'],
        key: 'tailor',
        scope: 'any',
        role: 'anyone',
        help: 'Reuse saved resume: skip upload and jump to JD step',
        category: 'resume',
    },
    {
        names: ['/cover', '/coverletter'],
        key: 'cover',
        scope: 'any',
        role: 'anyone',
        help: 'Cover letter from last tailored JD (or attach/paste JD)',
        category: 'resume',
    },
];

const nameIndex = new Map();
for (const def of COMMAND_REGISTRY) {
    for (const n of def.names) {
        nameIndex.set(n.toLowerCase(), def);
    }
}

/**
 * @param {string} cmdFirstToken e.g. '/ping'
 * @returns {CommandDefinition | undefined}
 */
export function findCommand(cmdFirstToken) {
    if (!cmdFirstToken) return undefined;
    const lower = String(cmdFirstToken).toLowerCase();
    const at = lower.indexOf('@');
    const base = at > 0 ? lower.slice(0, at) : lower;
    return nameIndex.get(base) || nameIndex.get(lower);
}

/**
 * Get all registered command names (for suggestions)
 */
export function getAllCommandNames() {
    return Array.from(nameIndex.keys());
}

/**
 * Simple string similarity (Levenshtein-like)
 */
function similarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) costs[j] = j;
            else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1))
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return (longer.length - costs[s2.length]) / longer.length;
}

/**
 * Find similar commands for suggestions
 */
export function findSimilarCommands(input, maxResults = 3) {
    if (!input) return [];
    const inputLower = input.toLowerCase().replace(/^\//, '');
    const allNames = getAllCommandNames();
    
    const matches = allNames
        .map(name => ({
            name,
            score: similarity(inputLower, name.replace(/^\//, ''))
        }))
        .filter(m => m.score > 0.3) // Min 30% similarity
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
    
    return matches.map(m => m.name);
}

/**
 * @param {{ isStaff?: boolean, isPrivileged?: boolean, canManageAdmins?: boolean }} access
 * @returns {string}
 */
function fmtCmd(def) {
    const primaryCmd = `\`${def.names[0]}\``;
    const aliases = def.names.length > 1 ? ` _(${def.names.slice(1).join(', ')})_` : '';
    return `  • ${primaryCmd}${aliases}\n    ↳ ${def.help}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * HELP MENU GROUPING
 *
 * `/help` groups by WHAT A COMMAND DOES, then filters by what the caller may
 * actually run. This is deliberately separate from `def.category`, which is a
 * legacy GATING flag ('movie' hides commands until a group enables movies).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Display bucket per command key. Every registry key should appear here. */
export const HELP_CATEGORY = {
    // Essentials
    ping: 'core', help: 'core', status: 'core', posted: 'core',
    checklimit: 'core', viewonce: 'core',

    // Movies
    movie: 'movie', upcoming: 'movie', genre: 'movie',

    // Media download / convert
    bypass: 'movie',
    insta: 'media', tw: 'media', toimg: 'media',

    // Stickers
    sticker: 'sticker', steal: 'sticker', rgb: 'sticker', tgstickers: 'sticker', tgstop: 'sticker', tgstickeron: 'sticker', tgstickeroff: 'sticker',

    // Markets
    tradenow: 'trade', swing: 'trade', expiry: 'trade', tradelert: 'trade', index: 'trade', scalp: 'trade', sweep: 'trade',
    svmkr: 'trade', chainai: 'trade', ipo: 'trade', backtest: 'trade',

    // Scheduled feeds
    news: 'daily', github: 'daily', awesome: 'daily', interviewq: 'daily',
    interviewqon: 'daily', interviewqoff: 'daily', iqboard: 'daily',
    tagme: 'daily', notag: 'daily', checktagstatus: 'daily', roast: 'resume', birthday: 'fun',

    // Fun
    horo: 'fun', advice: 'fun', facts: 'fun',

    // Resume tools
    resume: 'resume', tailor: 'resume', cover: 'resume',

    // Group setup & feature toggles
    link: 'group', revokelink: 'group',
    activate: 'group', deactivate: 'group', newson: 'group', newsoff: 'group',
    courson: 'group', coursesoff: 'group', githubon: 'group', githuboff: 'group',
    awesomeon: 'group', awesomeoff: 'group', aiupdateson: 'group', aiupdatesoff: 'group',
    instaon: 'group', instaoff: 'group',
    bypasson: 'group', bypassoff: 'group',
    stickeron: 'group', stickeroff: 'group', movieon: 'group', movieoff: 'group',
    summaryon: 'group', summaryoff: 'group', autochat: 'group', trending: 'group', setwc: 'group',

    // Moderation
    warn: 'moderation', warns: 'moderation', mywarns: 'moderation',
    clearwarns: 'moderation', dellast: 'moderation', delall: 'moderation',
    kick: 'moderation', ban: 'moderation', unban: 'moderation', banlist: 'moderation',

    // Bot administration
    groups: 'admin', pause: 'admin', resumecourses: 'admin', clear: 'admin',
    confirm: 'admin', cancel: 'admin', admins: 'admin', addadmin: 'admin',
    removeadmin: 'admin', increaselimit: 'admin', summarynow: 'admin',

    // Owner
    fix: 'owner', assist: 'owner', deploy: 'owner',
    addpremium: 'owner', removepremium: 'owner', premium: 'owner',
    addmod: 'owner', removemod: 'owner', addchannel: 'owner',
    removechannel: 'owner', channels: 'owner', grouppost: 'owner',
    driveurl: 'owner', scalpon: 'owner', scalpoff: 'owner', cmdlog: 'owner',
};

/** Section order and presentation. */
export const HELP_CATEGORIES = [
    { key: 'core', emoji: '📱', title: 'ESSENTIALS', blurb: 'Status & basics' },
    {
        key: 'movie',
        emoji: '🎬',
        title: 'MOVIES & SHOWS',
        blurb: 'Search and download',
        footer: '📊 *Free:* 5 searches/day · ⭐ *Premium:* unlimited\n💡 `/movie Pushpa 2` · `/genre horror`',
    },
    { key: 'media', emoji: '📥', title: 'MEDIA DOWNLOAD', blurb: 'Instagram, Twitter & conversions' },
    { key: 'sticker', emoji: '🎭', title: 'STICKERS', blurb: 'Create, steal, animate' },
    { key: 'trade', emoji: '📈', title: 'TRADING & MARKETS', blurb: 'NSE stocks, options, swing setups & IPO analysis' },
    { key: 'daily', emoji: '📰', title: 'DAILY FEEDS', blurb: 'News, repos & interview prep' },
    { key: 'fun', emoji: '🎲', title: 'FUN', blurb: 'Horoscope, advice, facts' },
    { key: 'resume', emoji: '📄', title: 'RESUME TOOLS', blurb: 'Tailor a CV to a job description' },
    { key: 'group', emoji: '⚙️', title: 'GROUP SETUP', blurb: 'Staff — enable features per group' },
    { key: 'moderation', emoji: '🛡️', title: 'MODERATION', blurb: 'Warnings & message cleanup' },
    { key: 'admin', emoji: '🔧', title: 'BOT ADMIN', blurb: 'Manage the bot & its admins' },
    { key: 'owner', emoji: '👑', title: 'OWNER TOOLS', blurb: 'Premium, deploy, assist' },
];

/** Display bucket for a command, defaulting to Essentials. */
export function helpCategoryOf(def) {
    return HELP_CATEGORY[def.key] || 'core';
}

/**
 * @param {object} opts
 * @param {boolean} opts.isStaff
 * @param {boolean} opts.isPrivileged
 * @param {boolean} opts.canManageAdmins
 * @param {boolean} opts.canSetWelcome
 * @param {boolean} opts.isOwner
 * @param {boolean} opts.isDirectMessage - user is in a private chat with the bot
 * @param {boolean} opts.movieOnly - group has only movie features, not full activation
 * @param {object}  opts.features  - { courses, insta, movie, trending, welcome }
 */
export function formatHelpText({
    isStaff = false,
    isPrivileged = false,
    canManageAdmins = false,
    canSetWelcome = false,
    isOwner = false,
    movieOnly = false,
    isDirectMessage = false,
    features = {},
} = {}) {
    /** Can this caller actually run the command? Mirrors access.js. */
    const canUse = (def) => {
        switch (def.role) {
            case 'staff':
                return isStaff;
            case 'admins':
            case 'group_admins':
                return isPrivileged;
            case 'admin_managers':
                return canManageAdmins;
            case 'welcome_setters':
                return canSetWelcome;
            case 'owner':
                return isOwner;
            default:
                return true; // 'anyone' and unset
        }
    };

    /**
     * Hide commands that cannot run in this chat type at all. Listing a
     * group-only command in a DM just invites a "GROUPS ONLY" rejection.
     */
    const inScope = (def) => {
        if (def.scope === 'group_only') return !isDirectMessage;
        if (def.scope === 'dm_only') return isDirectMessage;
        return true;
    };

    // Help is a command catalog, not a feature-status screen. A legacy
    // `category: movie` flag gates runtime access in some groups, but must not
    // hide commands (including owner tools) from users who are allowed to run
    // them. Role and chat scope remain enforced here.
    const visible = COMMAND_REGISTRY.filter((d) => canUse(d) && inScope(d));

    let out = '╔════════════════════════════════╗\n';
    out += '║   🤖 BOT COMMAND GUIDE 🤖   ║\n';
    out += '╚════════════════════════════════╝\n\n';

    let shown = 0;
    for (const section of HELP_CATEGORIES) {
        const cmds = visible.filter((d) => helpCategoryOf(d) === section.key);
        if (!cmds.length) continue;

        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += `${section.emoji} *${section.title}*\n`;
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        if (section.blurb) out += `_${section.blurb}_\n`;
        out += '\n';
        for (const def of cmds) out += fmtCmd(def) + '\n';
        if (section.footer) out += `\n${section.footer}\n`;
        out += '\n';
        shown += cmds.length;
    }

    if (!shown) {
        out += '_No commands are available to you in this chat._\n\n';
    }

    out += '╔════════════════════════════════╗\n';
    if (movieOnly) {
        out += '║ 🎬 MOVIE FEATURES ENABLED 🎬 ║\n';
        out += '║ 🍿 Use /movie to search 🍿  ║\n';
    } else {
        out += '║  📚 COURSES & 📰 NEWS ACTIVE   ║\n';
        out += '║   Posts at 10 AM & 10 PM IST   ║\n';
    }
    out += '╚════════════════════════════════╝\n';

    return out;
}
