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

function checkPassword() {
    const password = document.getElementById('password-input').value;
    const correctPassword = 'FriendsOnly2025'; // Guest password
    const errorEl = document.getElementById('password-error');
    if (password === correctPassword) {
        sessionStorage.setItem('authenticated', 'true');
        document.getElementById('password-prompt').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
    } else {
        errorEl.textContent = 'Incorrect password. Try again.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('authenticated') === 'true') {
        document.getElementById('main-content').style.display = 'block';
    } else {
        document.getElementById('password-prompt').style.display = 'block';
    }
});

document.getElementById('rsvp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const attending = document.getElementById('attending').value;
    const guests = document.getElementById('guests').value;
    const notes = document.getElementById('notes').value;
    const messageEl = document.getElementById('form-message');
    const eventCollection = 'rsvps-dinner-party'; // Change for each event

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
    } catch (error) {
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