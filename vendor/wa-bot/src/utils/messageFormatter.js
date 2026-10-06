/**
 * Message Formatter Utility
 * Formats course data into WhatsApp messages
 */

import { formatCompactCount, parseLooseCount } from './numberFormat.js';

export function formatCourseMessage(course) {
    const title = course.name || 'Untitled';
    let description = course.description || '';
    
    // Clean description - remove HTML tags and decode entities
    if (description) {
        description = description
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>')
            .replace(/\\u003cbr\\u003e/g, ' ')
            .replace(/\u003c/g, '<')
            .replace(/\u003e/g, '>')
            .replace(/\u003cbr\u003e/g, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
        
        // Clean up whitespace
        description = description.replace(/\s+/g, ' ');
        
        // Truncate if too long
        if (description.length > 180) {
            description = description.substring(0, 180) + '...';
        }
    }
    
    const price = parseFloat(course.price || 0);
    const sale = parseFloat(course.sale_price || 0);
    const rating = parseFloat(course.rating || 0);
    const views = parseLooseCount(course.views);
    const lectures = parseInt(course.lectures || 0);
    const lang = course.language || '';
    const category = course.category || '';
    const subcategory = course.subcategory || '';
    const store = course.store || '';
    const url = course.url || '';

    // Build professional message
    let message = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '🎓 *FREE COURSE ALERT!* 🎓\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    
    // Course Title
    message += `📚 *${title}*\n\n`;
    
    // Description
    if (description) {
        message += `📄 *What You'll Learn:*\n${description}\n\n`;
    }
    
    // Divider
    message += '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n';
    
    // Price Section
    if (price > 0 && sale === 0) {
        message += `💰 *Original Price:* ~$${price.toFixed(2)}~\n`;
        message += `✅ *Current Price:* *FREE*\n`;
        message += `🎁 *You Save:* $${price.toFixed(2)} (100% OFF)\n\n`;
    } else if (sale > 0 && sale < price) {
        const discount = Math.round(100 - (sale / price * 100));
        const savings = price - sale;
        message += `💰 *Original Price:* ~$${price.toFixed(2)}~\n`;
        message += `✅ *Current Price:* $${sale.toFixed(2)}\n`;
        message += `🎁 *You Save:* $${savings.toFixed(2)} (${discount}% OFF)\n\n`;
    } else {
        message += `✅ *Price:* FREE\n\n`;
    }
    
    // Course Information
    message += '📚 *Course Information:*\n';
    
    if (rating) {
        const stars = '⭐'.repeat(Math.floor(rating));
        message += `  • Rating: ${rating.toFixed(1)}/5.0 ${stars}\n`;
    }
    
    if (lectures) {
        message += `  • Total Lectures: ${lectures}\n`;
    }
    
    if (views) {
        message += `  • Enrolled Students: ${formatCompactCount(views)}\n`;
    }
    
    if (lang) {
        message += `  • Language: ${lang}\n`;
    }
    
    if (category) {
        message += `  • Category: ${category}`;
        if (subcategory) {
            message += ` → ${subcategory}`;
        }
        message += '\n';
    }
    
    if (store) {
        message += `  • Platform: ${store}\n`;
    }
    
    message += '\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n';
    
    // Call to action with URL
    message += '⚡ *Limited Time Offer - Enroll Now!* ⚡\n\n';
    message += `🔗 ${url}`;

    return message;
}
