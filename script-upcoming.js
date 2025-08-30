// Firebase config is loaded from firebase-config.js
// const db is available globally from firebase-config.js

async function loadUpcomingEvents() {
    try {
        console.log('Loading upcoming events...');
        const snapshot = await db.collection('events').where('isActive', '==', false).orderBy('createdAt', 'desc').get();
        
        const eventsContainer = document.getElementById('upcoming-events-container');
        const loadingDiv = document.getElementById('events-loading');
        const noEventsDiv = document.getElementById('no-upcoming-events');
        
        loadingDiv.style.display = 'none';
        
        if (snapshot.empty) {
            console.log('No upcoming events found');
            noEventsDiv.style.display = 'block';
            return;
        }
        
        console.log(`Found ${snapshot.size} upcoming events`);
        eventsContainer.innerHTML = '';
        
        snapshot.forEach(doc => {
            const data = doc.data();
            console.log('Event data:', data);
            
            const eventCard = document.createElement('div');
            eventCard.className = 'event-card';
            
            // Build menu HTML if menu exists
            let menuHTML = '';
            if (data.menu && data.menu.length > 0) {
                const menuItems = data.menu.map(item => `<li>${item}</li>`).join('');
                menuHTML = `
                    <p><strong>Menu:</strong></p>
                    <ul>${menuItems}</ul>
                `;
            }
            
            // Build schedule HTML if schedule exists
            let scheduleHTML = '';
            if (data.schedule && data.schedule.length > 0) {
                const scheduleItems = data.schedule.map(item => `<li>${item}</li>`).join('');
                scheduleHTML = `
                    <p><strong>Schedule:</strong></p>
                    <ul>${scheduleItems}</ul>
                `;
            }
            
            // Build what to bring HTML if specified
            let bringHTML = '';
            if (data.whatToBring && data.whatToBring.trim()) {
                bringHTML = `<p><strong>What to Bring:</strong> ${data.whatToBring}</p>`;
            }
            
            eventCard.innerHTML = `
                <img src="images/event1.jpg" alt="${data.name}" class="event-img">
                <div class="event-content">
                    <h3>${data.name}</h3>
                    <p><strong>Date & Time:</strong> ${data.date}</p>
                    ${data.description ? `<p><strong>Details:</strong> ${data.description}</p>` : ''}
                    ${menuHTML}
                    ${bringHTML}
                    ${scheduleHTML}
                </div>
            `;
            
            eventsContainer.appendChild(eventCard);
        });
        
    } catch (error) {
        console.error('Error loading upcoming events:', error);
        const loadingDiv = document.getElementById('events-loading');
        loadingDiv.textContent = 'Error loading events. Please refresh the page.';
        loadingDiv.style.color = 'red';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Use new auth system instead of sessionStorage
    if (!window.auth || !window.auth.requireAuth('guest')) {
        return; // Auth will handle redirect
    }
    
    // Load upcoming events
    loadUpcomingEvents();
});