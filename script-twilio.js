// Function to initialize contact form when admin content becomes visible
function initializeContactForm() {
    const contactForm = document.getElementById('contact-form');
    console.log('contact-form element:', contactForm);
    
    if (contactForm) {
        // Remove any existing event listeners to prevent duplicates
        const newContactForm = contactForm.cloneNode(true);
        contactForm.parentNode.replaceChild(newContactForm, contactForm);
        
        newContactForm.addEventListener('submit', async (e) => {
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
                
                // Refresh both the main contacts table and the dynamic contact list
                if (typeof loadContacts === 'function') {
                    loadContacts();
                }
                if (typeof populateDynamicContactList === 'function') {
                    populateDynamicContactList();
                }
            } catch (error) {
                console.error('Contact error:', error);
                messageEl.textContent = `Error adding contact: ${error.message}`;
                messageEl.style.color = 'red';
            }
        });
    } else {
        console.error('contact-form not found in DOM');
    }
}

// Function to initialize invite form
function initializeInviteForm() {
    const inviteForm = document.getElementById('invite-form');
    console.log('invite-form element:', inviteForm);
    
    if (inviteForm) {
        // Remove any existing event listeners to prevent duplicates
        const newInviteForm = inviteForm.cloneNode(true);
        inviteForm.parentNode.replaceChild(newInviteForm, inviteForm);
        
        newInviteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const eventName = document.getElementById('event-select').value;
            const phoneNumbers = document.getElementById('phone-numbers').value.split(',').map(num => num.trim());
            const message = document.getElementById('invite-message').value || `You're invited to ${eventName.replace('-', ' ')} at Pine Grove Gatherings! RSVP at https://75pinegrove.com with password FriendsOnly2025`;
            const messageEl = document.getElementById('invite-message');

            try {
                const response = await fetch('https://us-central1-piveevents.cloudfunctions.net/sendInvites', {
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
}

document.addEventListener('DOMContentLoaded', () => {
    // Only initialize invite form on DOM load since it might be visible initially
    // Contact form initialization will be handled when admin content becomes visible
    
    // Try to initialize invite form if it's available
    setTimeout(() => {
        initializeInviteForm();
    }, 100);
});

// Export functions to be called from script-admin.js when admin content is shown
window.initializeContactForm = initializeContactForm;
window.initializeInviteForm = initializeInviteForm;