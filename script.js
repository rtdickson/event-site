const firebaseConfig = {
    apiKey: "AIzaSyDrunOzCIlX9iqYEhpWGqDlN8sUBaF44po",
    authDomain: "piveevents.firebaseapp.com",
    projectId: "piveevents",
    storageBucket: "piveevents.firebasestorage.app",
    messagingSenderId: "635106763509",
    appId: "1:635106763509:web:1f18f4e10da36177f0dbbc",
    measurementId: "G-2VW032KXE8"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Store active event data globally
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

function checkPassword() {
    const password = document.getElementById('password-input').value;
    const correctPassword = 'FriendsOnly2025'; // Guest password
    const errorEl = document.getElementById('password-error');
    if (password === correctPassword) {
        sessionStorage.setItem('authenticated', 'true');
        document.getElementById('password-prompt').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        // Load the active event after authentication
        loadActiveEvent();
    } else {
        errorEl.textContent = 'Incorrect password. Try again.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('authenticated') === 'true') {
        document.getElementById('main-content').style.display = 'block';
        // Load the active event on page load if already authenticated
        loadActiveEvent();
    } else {
        document.getElementById('password-prompt').style.display = 'block';
    }
});

document.getElementById('rsvp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!activeEventData) {
        document.getElementById('form-message').textContent = 'Error: No active event found.';
        document.getElementById('form-message').style.color = 'red';
        return;
    }
    
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
        messageEl.textContent = 'Error submitting RSVP. Try again.';
        messageEl.style.color = 'red';
    }
});

document.getElementById('guest-list-form').addEventListener('submit', async (e) => {
    e.preventDefault();
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
        messageEl.textContent = 'Error submitting request. Try again.';
        messageEl.style.color = 'red';
    }
});