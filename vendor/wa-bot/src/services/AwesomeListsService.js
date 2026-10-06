/**
 * Fetch "awesome-*" GitHub lists (curated learning/tools collections).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const SEARCH_URL = 'https://api.github.com/search/repositories';

const API_HEADERS = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'whatsapp-course-bot-awesome',
};

/** Seed pool if API is rate-limited / down */
const FALLBACK_LISTS = [
    {
        fullName: 'sindresorhus/awesome',
        url: 'https://github.com/sindresorhus/awesome',
        description: 'Awesome lists about all kinds of interesting topics',
        language: '—',
        totalStars: '',
        topic: 'meta',
    },
    {
        fullName: 'vinta/awesome-python',
        url: 'https://github.com/vinta/awesome-python',
        description: 'A curated list of awesome Python frameworks, libraries, software and resources',
        language: 'Python',
        totalStars: '',
        topic: 'python',
    },
    {
        fullName: 'awesome-selfhosted/awesome-selfhosted',
        url: 'https://github.com/awesome-selfhosted/awesome-selfhosted',
        description: 'A list of Free Software network services and web applications which can be hosted on your own servers',
        language: '—',
        totalStars: '',
        topic: 'selfhosted',
    },
    {
        fullName: 'LeCoupa/awesome-cheatsheets',
        url: 'https://github.com/LeCoupa/awesome-cheatsheets',
        description: 'Awesome cheatsheets for popular programming languages, frameworks and development tools',
        language: 'JavaScript',
        totalStars: '',
        topic: 'cheatsheets',
    },
    {
        fullName: 'avelino/awesome-go',
        url: 'https://github.com/avelino/awesome-go',
        description: 'A curated list of awesome Go frameworks, libraries and software',
        language: 'Go',
        totalStars: '',
        topic: 'go',
    },
    {
        fullName: 'vuejs/awesome-vue',
        url: 'https://github.com/vuejs/awesome-vue',
        description: '🎉 A curated list of awesome things related to Vue.js',
        language: '—',
        totalStars: '',
        topic: 'vue',
    },
    {
        fullName: 'enaqx/awesome-react',
        url: 'https://github.com/enaqx/awesome-react',
        description: 'A collection of awesome things regarding React ecosystem',
        language: '—',
        totalStars: '',
        topic: 'react',
    },
    {
        fullName: 'sindresorhus/awesome-nodejs',
        url: 'https://github.com/sindresorhus/awesome-nodejs',
        description: '⚡️ Delightful Node.js packages and resources',
        language: '—',
        totalStars: '',
        topic: 'nodejs',
    },
    {
        fullName: 'trimstray/the-book-of-secret-knowledge',
        url: 'https://github.com/trimstray/the-book-of-secret-knowledge',
        description: 'A collection of inspiring lists, manuals, cheatsheets, blogs, hacks, one-liners, cli/web tools and more',
        language: '—',
        totalStars: '',
        topic: 'ops',
    },
    {
        fullName: 'practical-tutorials/project-based-learning',
        url: 'https://github.com/practical-tutorials/project-based-learning',
        description: 'Curated list of project-based tutorials for learning a programming language or technology',
        language: '—',
        totalStars: '',
        topic: 'learning',
    },
];

function mapApiItem(item) {
    return {
        fullName: item.full_name || '',
        url: item.html_url || '',
        description: item.description || 'Curated awesome list',
        language: item.language || '—',
        totalStars: item.stargazers_count != null ? String(item.stargazers_count) : '',
        forks: item.forks_count != null ? String(item.forks_count) : '',
        topic: 'awesome',
    };
}

function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

export function dedupeAwesomeLists(lists) {
    const seen = new Set();
    return (lists || []).filter((item) => {
        const key = String(item.fullName || '')
            .trim()
            .toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

class AwesomeListsService {
    constructor(count = 5) {
        this.count = count;
    }

    async _searchAwesome(limit = 30) {
        const resp = await axios.get(SEARCH_URL, {
            params: {
                q: 'awesome- in:name stars:>800',
                sort: 'stars',
                order: 'desc',
                per_page: Math.min(50, Math.max(limit, 20)),
            },
            headers: API_HEADERS,
            timeout: 20000,
            validateStatus: (s) => s < 500,
        });

        if (resp.status !== 200 || !Array.isArray(resp.data?.items)) {
            throw new Error(`GitHub search HTTP ${resp.status}`);
        }

        return resp.data.items
            .filter((item) => /^awesome[-_/]/i.test(item.name || '') || /\/awesome/i.test(item.full_name || ''))
            .map(mapApiItem);
    }

    async fetchPool(limit = 20) {
        try {
            const fromApi = await this._searchAwesome(limit);
            const merged = dedupeAwesomeLists([...fromApi, ...FALLBACK_LISTS]);
            logger.info(`Awesome lists pool: ${merged.length} (API + fallback)`);
            return shuffle(merged);
        } catch (err) {
            logger.warn(`Awesome lists API failed (${err.message}) — using fallback pool`);
            return shuffle(FALLBACK_LISTS);
        }
    }

    /** Preview / manual: up to `count` shuffled lists */
    async fetchPreviewLists() {
        const pool = await this.fetchPool(30);
        return pool.slice(0, this.count);
    }

    /** Scheduled slot: one random list from a fresh pool */
    async fetchRandomList() {
        const pool = await this.fetchPool(40);
        return pool[0] || null;
    }
}

export default AwesomeListsService;
