document.addEventListener('DOMContentLoaded', () => {
    const inviteForm = document.getElementById('invite-form');
    console.log('invite-form element:', inviteForm); // Add console log here
    if (inviteForm) {
        inviteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const eventName = document.getElementById('event-select').value;
            const phoneNumbers = document.getElementById('phone-numbers').value.split(',').map(num => num.trim());
            const message = document.getElementById('invite-message').value || `You're invited to ${eventName.replace('-', ' ')} at Pine Grove Gatherings! RSVP at https://75pinegrove.com with password FriendsOnly2025`;
            const messageEl = document.getElementById('invite-message');

            try {
                const response = await fetch('http://127.0.0.1:5001/piveevents/us-central1/sendInvites', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ eventName, phoneNumbers, message })
                });
                const result = await response.json();
                if (result.success) {
                    messageEl.textContent = 'Invites sent successfully!';
                    messageEl.style.color = 'green';
                    document.getElementById('invite-form').reset();
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                console.error('Invite error:', error);
                messageEl.textContent = `Error sending invites: ${error.message}`;
                messageEl.style.color = 'red';
            }
        });
    } else {
        console.error('invite-form not found in DOM');
    }

    const contactForm = document.getElementById('contact-form');
    console.log('contact-form element:', contactForm); // Optional: Add console log for contact-form
    if (contactForm) {
        contactForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('contact-name').value;
            const phone = document.getElementById('contact-phone').value;
            const messageEl = document.getElementById('contact-message');

            try {
                await firebase.firestore().collection('contacts').add({
                    name: name || 'Unknown',
                    phone,
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });
                messageEl.textContent = 'Contact added!';
                messageEl.style.color = 'green';
                document.getElementById('contact-form').reset();
                loadContacts();
            } catch (error) {
                console.error('Contact error:', error);
                messageEl.textContent = `Error adding contact: ${error.message}`;
                messageEl.style.color = 'red';
            }
        });
    } else {
        console.error('contact-form not found in DOM');
    }
});