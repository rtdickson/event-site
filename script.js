document.getElementById('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password-input').value;
    const correctPassword = 'FriendsOnly2025';
    const errorEl = document.getElementById('password-error');
    if (password === correctPassword) {
        sessionStorage.setItem('authenticated', 'true');
        document.getElementById('password-form').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
    } else {
        errorEl.textContent = 'Incorrect password. Try again.';
        errorEl.style.color = 'red';
    }
});

document.getElementById('rsvp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('rsvp-name').value;
    const phone = document.getElementById('rsvp-phone').value;
    const attending = document.querySelector('input[name="attending"]:checked')?.value || '';
    const guests = parseInt(document.getElementById('rsvp-guests').value) || 0;
    const notes = document.getElementById('rsvp-notes').value;
    const messageEl = document.getElementById('rsvp-message');

    try {
        await firebase.firestore().collection('rsvps-dinner-party').add({
            name: name || 'Unknown',
            phone,
            attending,
            guests,
            notes,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        messageEl.textContent = 'RSVP submitted!';
        messageEl.style.color = 'green';
        document.getElementById('rsvp-form').reset();
    } catch (error) {
        console.error('RSVP error:', error);
        messageEl.textContent = `Error submitting RSVP: ${error.message}`;
        messageEl.style.color = 'red';
    }
});

document.getElementById('guest-list-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('guest-list-phone').value;
    const messageEl = document.getElementById('guest-list-message');

    try {
        await firebase.firestore().collection('guest-list-requests').add({
            phone,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        messageEl.textContent = 'Guest list request submitted!';
        messageEl.style.color = 'green';
        document.getElementById('guest-list-form').reset();
    } catch (error) {
        console.error('Guest list request error:', error);
        messageEl.textContent = `Error submitting request: ${error.message}`;
        messageEl.style.color = 'red';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('authenticated') === 'true') {
        document.getElementById('password-form').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
    }
});