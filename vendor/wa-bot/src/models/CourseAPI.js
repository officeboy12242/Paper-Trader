/**
 * Course API Model
 * Handles fetching courses from the API
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

class CourseAPI {
    constructor() {
        // API endpoint (obfuscated)
        const _X = [104,116,116,112,115,58,47,47,99,100,110,46,114,101,97,108,46,100,105,115,99,111,117,110,116,47,97,112,105,47,99,111,117,114,115,101,115];
        this.endpoint = String.fromCharCode(..._X);
        this.allowedLanguages = ['english', 'hindi', 'urdu'];
    }

    async fetchPage(page, limit = 14) {
        try {
            const response = await axios.get(this.endpoint, {
                params: { page, limit, sortBy: 'sale_start' },
                timeout: 15000
            });
            return response.data.items || [];
        } catch (error) {
            logger.error(`API error (page ${page}): ${error.message}`);
            return [];
        }
    }

    async fetchNewCourses() {
        const newCourses = [];
        
        // Only fetch page 1 for quick refresh
        const items = await this.fetchPage(1, 20);
        
        if (!items || items.length === 0) {
            logger.info('❌ No items from API');
            return newCourses;
        }

        // Filter for free courses with allowed languages
        for (const course of items) {
            // Check if course is free
            const salePrice = parseFloat(course.sale_price || 0);
            
            // Check language
            const lang = (course.language || '').toLowerCase();
            
            // Only add if sale price is 0 (free) AND language is allowed
            if (salePrice === 0 && this.allowedLanguages.includes(lang)) {
                newCourses.push(course);
            }
        }
        
        logger.info(`📊 Page 1: ${items.length} total | ${newCourses.length} free courses (allowed languages)`);
        return newCourses;
    }
}

export default CourseAPI;
