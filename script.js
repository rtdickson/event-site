// Firebase config is loaded from firebase-config.js
// const db is available globally from firebase-config.js

// Store active event data globally
console.log('script.js loaded');

let activeEventData = null;

async function loadActiveEvent() {
    try {
        console.log('Loading active event...');
        const snapshot = await db.collection('events').where('isActive', '==', true).limit(1).get();
        
        if (snapshot.empty) {
            console.log('No active event found');
            document.getElementById('event-loading').style.display = 'none';
            document.getElementById('no-active-event').style.display = 'block';
            return;
        }
        
        const eventDoc = snapshot.docs[0];
        activeEventData = eventDoc.data();
        console.log('Active event data:', activeEventData);
        
        // Check if all required elements exist before setting content
        const eventNameEl = document.getElementById('event-name');
        const eventDateEl = document.getElementById('event-date');
        const eventDescEl = document.getElementById('event-description');
        const eventBringEl = document.getElementById('event-bring');
        const rsvpTitleEl = document.getElementById('rsvp-title');
        
        if (!eventNameEl || !eventDateEl || !eventDescEl || !eventBringEl || !rsvpTitleEl) {
            console.error('One or more required DOM elements not found');
            return;
        }
        
        // Populate event details
        eventNameEl.textContent = activeEventData.name;
        eventDateEl.textContent = activeEventData.date;
        eventDescEl.textContent = activeEventData.description || 'No description available';
        eventBringEl.textContent = activeEventData.whatToBring || 'Nothing specified';
        rsvpTitleEl.textContent = `${activeEventData.name} RSVP`;
        
        // Populate menu items
        const menuList = document.getElementById('event-menu');
        const menuSection = document.getElementById('menu-section');
        if (menuList && menuSection) {
            menuList.innerHTML = '';
            if (activeEventData.menu && activeEventData.menu.length > 0) {
                activeEventData.menu.forEach(item => {
                    if (item.trim()) {
                        const li = document.createElement('li');
                        li.textContent = item;
                        menuList.appendChild(li);
                    }
                });
                menuSection.style.display = 'block';
            } else {
                menuSection.style.display = 'none';
            }
        }
        
        // Populate schedule items
        const scheduleList = document.getElementById('event-schedule');
        const scheduleSection = document.getElementById('schedule-section');
        if (scheduleList && scheduleSection) {
            scheduleList.innerHTML = '';
            if (activeEventData.schedule && activeEventData.schedule.length > 0) {
                activeEventData.schedule.forEach(item => {
                    if (item.trim()) {
                        const li = document.createElement('li');
                        li.textContent = item;
                        scheduleList.appendChild(li);
                    }
                });
                scheduleSection.style.display = 'block';
            } else {
                scheduleSection.style.display = 'none';
            }
        }
        
        // Show the event content and other sections
        document.getElementById('event-loading').style.display = 'none';
        document.getElementById('event-content').style.display = 'block';
        document.getElementById('rsvp').style.display = 'block';
        document.getElementById('guest-list-request').style.display = 'block';
        
        // Load weather AFTER all DOM elements are populated
        loadWeatherForEvent();
        
    } catch (error) {
        console.error('Error loading active event:', error);
        const loadingEl = document.getElementById('event-loading');
        if (loadingEl) {
            loadingEl.textContent = 'Error loading event. Please refresh the page.';
        }
    }
}

// Page initialization function called by auth system
function initializePage() {
    loadActiveEvent();
}

document.addEventListener('DOMContentLoaded', () => {
    // Check if already authenticated
    if (window.auth && window.auth.isAuthenticated()) {
        document.getElementById('password-prompt').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        initializePage();
    } else {
        document.getElementById('password-prompt').style.display = 'block';
        
        // Add enter key support for password input
        const passwordInput = document.getElementById('password-input');
        if (passwordInput) {
            passwordInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    handlePasswordSubmit();
                }
            });
            passwordInput.focus();
        }
        
        // Update the button onclick to use the correct function
        const submitButton = document.querySelector('#password-prompt button');
        if (submitButton) {
            submitButton.onclick = handlePasswordSubmit;
            submitButton.removeAttribute('onclick');
        }
    }
});

// Handle password submission
async function handlePasswordSubmit() {
    const passwordInput = document.getElementById('password-input');
    const errorEl = document.getElementById('password-error');
    const submitButton = document.querySelector('#password-prompt button');
    
    if (!passwordInput || !passwordInput.value) {
        errorEl.textContent = 'Please enter a password.';
        return;
    }

    // Show loading state
    submitButton.disabled = true;
    submitButton.textContent = 'Verifying...';
    errorEl.textContent = '';

    try {
        const isValid = await window.auth.login(passwordInput.value, 'guest');
        
        if (isValid) {
            // Success - show content
            document.getElementById('password-prompt').style.display = 'none';
            document.getElementById('main-content').style.display = 'block';
            initializePage();
        } else {
            errorEl.textContent = 'Incorrect password. Please try again.';
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (error) {
        console.error('Authentication error:', error);
        errorEl.textContent = 'Authentication failed. Please try again.';
    } finally {
        // Reset button state
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
}

// Add this to script.js

// Weather widget functionality
// Updated weather widget - more forgiving date parsing and always shows for testing
// Updated weather function for your date format
// Add these weather functions to your script.js file

// Weather widget functionality
async function loadWeatherForEvent() {
    const weatherContainer = document.getElementById('weather-widget');
    if (!weatherContainer || !activeEventData) return;
    
    console.log('Loading weather for event:', activeEventData.name, 'Date:', activeEventData.date);
    
    weatherContainer.innerHTML = '<div class="weather-loading">Loading weather...</div>';
    weatherContainer.style.display = 'block';
    
    try {
        // Parse your event date format
        const eventDate = parseEventDate(activeEventData.date);
        console.log('Parsed event date:', eventDate);
        
        // Check if event is within 7-day forecast range
        if (!eventDate || !isEventWithinWeekWeather(eventDate)) {
            console.log('Event date outside forecast range or unparseable');
            weatherContainer.style.display = 'none';
            return;
        }
        
        // Get weather forecast
        const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=45.4215&longitude=-75.6972&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=America/Toronto&forecast_days=7');
        
        if (!response.ok) throw new Error('Weather API failed');
        
        const data = await response.json();
        console.log('Weather API response:', data);
        
        // Find the weather for the actual event date
        const eventDateStr = eventDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        console.log('Looking for date:', eventDateStr);
        
        const dayIndex = data.daily.time.findIndex(date => date === eventDateStr);
        console.log('Day index found:', dayIndex);
        
        if (dayIndex === -1) {
            weatherContainer.innerHTML = '<div class="weather-error">Weather not available for event date</div>';
            return;
        }
        
        const maxTemp = Math.round(data.daily.temperature_2m_max[dayIndex]);
        const minTemp = Math.round(data.daily.temperature_2m_min[dayIndex]);
        const weatherCode = data.daily.weather_code[dayIndex];
        
        const weatherInfo = getWeatherInfo(weatherCode);
        
        // Show if it's today, tomorrow, or the specific day
        let dayLabel = '';
        const today = new Date();
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        
        if (eventDate.toDateString() === today.toDateString()) {
            dayLabel = 'Today';
        } else if (eventDate.toDateString() === tomorrow.toDateString()) {
            dayLabel = 'Tomorrow';
        } else {
            dayLabel = eventDate.toLocaleDateString('en-US', { weekday: 'long' });
        }
        
        weatherContainer.innerHTML = `
            <div class="weather-widget-content">
                <div class="weather-icon">${weatherInfo.icon}</div>
                <div class="weather-temps">
                    <span class="temp-high">${maxTemp}°</span>
                    <span class="temp-low">${minTemp}°</span>
                </div>
                <div class="weather-desc">${weatherInfo.description}</div>
                <div class="weather-note">${dayLabel}</div>
            </div>
        `;
        
    } catch (error) {
        console.error('Error loading weather:', error);
        weatherContainer.innerHTML = '<div class="weather-error">Weather unavailable</div>';
    }
}

// Simplified date parsing for your format
function parseEventDate(dateString) {
    if (!dateString) return null;
    
    console.log('Parsing date string:', dateString);
    
    // Your format: "September 4, 2025" with possible time
    // Extract just the date part before any time info
    let datePart = dateString.split(' at ')[0].split(' from ')[0];
    
    // Clean up any extra text after the year
    const match = datePart.match(/(\w+\s+\d{1,2},?\s+\d{4})/);
    if (match) {
        datePart = match[1];
    }
    
    console.log('Extracted date part:', datePart);
    
    // Use JavaScript's built-in Date parsing
    const parsed = new Date(datePart);
    console.log('Parsed result:', parsed);
    
    return isNaN(parsed.getTime()) ? null : parsed;
}

// Check if event is within 7-day forecast
function isEventWithinWeekWeather(eventDate) {
    const today = new Date();
    const sevenDaysFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    // Set time to start of day for comparison
    const eventDateStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    
    return eventDateStart >= todayStart && eventDateStart <= sevenDaysFromNow;
}

// Convert weather code to icon and description
function getWeatherInfo(code) {
    const weatherCodes = {
        0: { icon: '☀️', description: 'Clear sky' },
        1: { icon: '🌤️', description: 'Mainly clear' },
        2: { icon: '⛅', description: 'Partly cloudy' },
        3: { icon: '☁️', description: 'Overcast' },
        45: { icon: '🌫️', description: 'Foggy' },
        48: { icon: '🌫️', description: 'Rime fog' },
        51: { icon: '🌦️', description: 'Light drizzle' },
        53: { icon: '🌦️', description: 'Moderate drizzle' },
        55: { icon: '🌧️', description: 'Dense drizzle' },
        61: { icon: '🌧️', description: 'Slight rain' },
        63: { icon: '🌧️', description: 'Moderate rain' },
        65: { icon: '🌧️', description: 'Heavy rain' },
        71: { icon: '❄️', description: 'Slight snow' },
        73: { icon: '❄️', description: 'Moderate snow' },
        75: { icon: '❄️', description: 'Heavy snow' },
        80: { icon: '🌦️', description: 'Slight showers' },
        81: { icon: '🌧️', description: 'Moderate showers' },
        82: { icon: '🌧️', description: 'Violent showers' },
        95: { icon: '⛈️', description: 'Thunderstorm' },
        96: { icon: '⛈️', description: 'Thunderstorm with hail' },
        99: { icon: '⛈️', description: 'Heavy thunderstorm' }
    };
    
    return weatherCodes[code] || { icon: '🌤️', description: 'Unknown' };
}
// Update the initializePage function to include weather loading
function initializePage() {
    loadActiveEvent().then(() => {
        loadWeatherForEvent(); // Add this line
    });
}

document.getElementById('rsvp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!activeEventData) {
        document.getElementById('form-message').textContent = 'Error: No active event found.';
        document.getElementById('form-message').style.color = 'red';
        return;
    }
    
    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    
    // Show loading state
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting...';
    
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const attending = document.getElementById('attending').value;
    const guests = document.getElementById('guests').value;
    const notes = document.getElementById('notes').value;
    const messageEl = document.getElementById('form-message');
    
    // Use the active event's collection name
    const eventCollection = activeEventData.collectionName;
    console.log('Submitting RSVP to collection:', eventCollection);

    try {
        await db.collection(eventCollection).add({
            name,
            phone,
            attending,
            guests: parseInt(guests),
            notes,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        messageEl.textContent = 'RSVP submitted! Thank you!';
        messageEl.style.color = 'green';
        document.getElementById('rsvp-form').reset();
        document.getElementById('guests').value = '1'; // Reset to default
    } catch (error) {
        console.error('Error submitting RSVP:', error);
        messageEl.textContent = 'Error submitting RSVP. Please try again.';
        messageEl.style.color = 'red';
    } finally {
        // Reset button state
        submitButton.disabled = false;
        submitButton.textContent = originalText;
    }
});

document.getElementById('guest-list-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    
    // Show loading state
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting...';
    
    const phone = document.getElementById('request-phone').value;
    const messageEl = document.getElementById('request-message');
    
    try {
        await db.collection('guest-list-requests').add({
            phone,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        messageEl.textContent = 'Request submitted! You will receive the guest list soon.';
        messageEl.style.color = 'green';
        document.getElementById('guest-list-form').reset();
        document.getElementById('guest-list-form').style.display = 'none';
        document.querySelector('#guest-list-request button').style.display = 'block';
    } catch (error) {
        console.error('Error submitting guest list request:', error);
        messageEl.textContent = 'Error submitting request. Please try again.';
        messageEl.style.color = 'red';
    } finally {
        // Reset button state
        submitButton.disabled = false;
        submitButton.textContent = originalText;
    }
});