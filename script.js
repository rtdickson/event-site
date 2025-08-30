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
        
        // Populate event details
        document.getElementById('event-name').textContent = activeEventData.name;
        document.getElementById('event-date').textContent = activeEventData.date;
        document.getElementById('event-description').textContent = activeEventData.description || 'No description available';
        document.getElementById('event-bring').textContent = activeEventData.whatToBring || 'Nothing specified';
        
        // Update RSVP section title
        document.getElementById('rsvp-title').textContent = `${activeEventData.name} RSVP`;
        
        // Populate menu items
        const menuList = document.getElementById('event-menu');
        menuList.innerHTML = '';
        if (activeEventData.menu && activeEventData.menu.length > 0) {
            activeEventData.menu.forEach(item => {
                if (item.trim()) {
                    const li = document.createElement('li');
                    li.textContent = item;
                    menuList.appendChild(li);
                }
            });
            document.getElementById('menu-section').style.display = 'block';
        } else {
            document.getElementById('menu-section').style.display = 'none';
        }
        
        // Populate schedule items
        const scheduleList = document.getElementById('event-schedule');
        scheduleList.innerHTML = '';
        if (activeEventData.schedule && activeEventData.schedule.length > 0) {
            activeEventData.schedule.forEach(item => {
                if (item.trim()) {
                    const li = document.createElement('li');
                    li.textContent = item;
                    scheduleList.appendChild(li);
                }
            });
            document.getElementById('schedule-section').style.display = 'block';
        } else {
            document.getElementById('schedule-section').style.display = 'none';
        }
        
        // Show the event content and RSVP sections
        document.getElementById('event-loading').style.display = 'none';
        document.getElementById('event-content').style.display = 'block';
        document.getElementById('rsvp').style.display = 'block';
        document.getElementById('guest-list-request').style.display = 'block';
        
    } catch (error) {
        console.error('Error loading active event:', error);
        document.getElementById('event-loading').textContent = 'Error loading event. Please refresh the page.';
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