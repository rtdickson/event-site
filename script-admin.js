const db = firebase.firestore();

// Move all function definitions before checkAdminPassword
async function populateDynamicContactList() {
    const listContainer = document.getElementById('dynamic-contact-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    try {
        const snapshot = await db.collection('contacts').orderBy('timestamp', 'desc').get();
        
        // Add "Add Selected" button at the top
        const headerDiv = document.createElement('div');
        headerDiv.className = 'contact-list-header';
        headerDiv.innerHTML = `
            <button onclick="addSelectedToInvite()" style="margin-bottom: 10px; background-color: #4CAF50; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Add Selected to Invite</button>
        `;
        listContainer.appendChild(headerDiv);

        snapshot.forEach(doc => {
            const data = doc.data();
            const contactDiv = document.createElement('div');
            contactDiv.className = 'contact-entry';
            contactDiv.style.cssText = 'display: flex; align-items: center; margin-bottom: 8px; padding: 6px; border: 1px solid #ddd; border-radius: 4px;';
            contactDiv.innerHTML = `
                <input type="checkbox" id="contact-${doc.id}" value="${data.phone}" style="margin-right: 8px;" />
                <label for="contact-${doc.id}" style="flex: 1; cursor: pointer;"><strong>${data.name}</strong>: ${data.phone}</label>
                <button onclick="addToInvite('${data.phone}')" style="background: none; border: none; font-size: 18px; color: #4CAF50; cursor: pointer; padding: 4px;" title="Add to invite">+</button>
            `;
            listContainer.appendChild(contactDiv);
        });
    } catch (error) {
        console.error('Error loading dynamic contact list:', error);
    }
}

function addToInvite(phone) {
    const inputField = document.getElementById('phone-numbers');
    if (inputField.value.trim() === '') {
        inputField.value = phone;
    } else {
        // Check if phone number is already in the list to avoid duplicates
        const existingNumbers = inputField.value.split(',').map(num => num.trim());
        if (!existingNumbers.includes(phone)) {
            inputField.value += ',' + phone;
        }
    }
}

function addSelectedToInvite() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list input[type="checkbox"]:checked');
    const inputField = document.getElementById('phone-numbers');
    
    if (checkboxes.length === 0) {
        alert('Please select at least one contact to add.');
        return;
    }
    
    const selectedNumbers = Array.from(checkboxes).map(cb => cb.value);
    const existingNumbers = inputField.value.trim() === '' ? [] : inputField.value.split(',').map(num => num.trim());
    
    // Filter out duplicates
    const newNumbers = selectedNumbers.filter(num => !existingNumbers.includes(num));
    
    if (newNumbers.length === 0) {
        alert('All selected contacts are already in the invite list.');
        return;
    }
    
    // Add new numbers
    if (inputField.value.trim() === '') {
        inputField.value = newNumbers.join(',');
    } else {
        inputField.value += ',' + newNumbers.join(',');
    }
    
    // Uncheck all checkboxes
    checkboxes.forEach(cb => cb.checked = false);
}

async function loadRSVPs() {
    const groupsDiv = document.getElementById('rsvp-groups');
    groupsDiv.innerHTML = '';
    const events = ['dinner-party', 'fall-picnic', 'halloween-party'];

    for (const eventName of events) {
        const groupDiv = document.createElement('div');
        groupDiv.innerHTML = `<h3>${eventName.charAt(0).toUpperCase() + eventName.slice(1).replace('-', ' ')} RSVPs</h3>
            <button onclick="deleteAllForEvent('rsvps-${eventName}')">Delete All for This Event</button>
            <table id="rsvp-table-${eventName}">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Phone</th>
                        <th>Attending</th>
                        <th>Guests</th>
                        <th>Notes</th>
                        <th>Timestamp</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>`;
        groupsDiv.appendChild(groupDiv);

        const tableBody = groupDiv.querySelector('tbody');
        try {
            const snapshot = await db.collection(`rsvps-${eventName}`).orderBy('timestamp', 'desc').get();
            snapshot.forEach(doc => {
                const data = doc.data();
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${data.name}</td>
                    <td>${data.phone || ''}</td>
                    <td>${data.attending}</td>
                    <td>${data.guests}</td>
                    <td>${data.notes || ''}</td>
                    <td>${data.timestamp ? data.timestamp.toDate().toLocaleString() : ''}</td>
                    <td><button onclick="deleteRSVP('${doc.id}', 'rsvps-${eventName}')">Delete</button></td>
                `;
                tableBody.appendChild(row);
            });
        } catch (error) {
            console.error(`Error loading RSVPs for rsvps-${eventName}:`, error);
        }
    }
}

async function deleteRSVP(id, collectionName) {
    if (confirm('Delete this RSVP?')) {
        try {
            await db.collection(collectionName).doc(id).delete();
            loadRSVPs();
        } catch (error) {
            console.error('Error deleting RSVP:', error);
        }
    }
}

async function deleteAllForEvent(collectionName) {
    if (confirm(`Delete all RSVPs for ${collectionName.replace('rsvps-', '').replace('-', ' ')}?`)) {
        try {
            const snapshot = await db.collection(collectionName).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            loadRSVPs();
        } catch (error) {
            console.error(`Error deleting all for ${collectionName}:`, error);
        }
    }
}

async function loadGuestListRequests() {
    const tableBody = document.getElementById('request-table').querySelector('tbody');
    tableBody.innerHTML = '';
    try {
        const snapshot = await db.collection('guest-list-requests').orderBy('timestamp', 'desc').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${data.phone}</td>
                <td>${data.timestamp ? data.timestamp.toDate().toLocaleString() : ''}</td>
                <td><button onclick="deleteRequest('${doc.id}')">Delete</button></td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading guest list requests:', error);
    }
}

async function deleteRequest(id) {
    if (confirm('Delete this guest list request?')) {
        try {
            await db.collection('guest-list-requests').doc(id).delete();
            loadGuestListRequests();
        } catch (error) {
            console.error('Error deleting request:', error);
        }
    }
}

async function loadContacts() {
    const tableBody = document.getElementById('contact-table').querySelector('tbody');
    tableBody.innerHTML = '';
    try {
        const snapshot = await db.collection('contacts').orderBy('timestamp', 'desc').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${data.name || ''}</td>
                <td>${data.phone}</td>
                <td><button onclick="deleteContact('${doc.id}')">Delete</button></td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

async function deleteContact(id) {
    if (confirm('Delete this contact?')) {
        try {
            await db.collection('contacts').doc(id).delete();
            loadContacts();
            // Refresh the dynamic contact list as well
            populateDynamicContactList();
        } catch (error) {
            console.error('Error deleting contact:', error);
        }
    }
}

function checkAdminPassword() {
    console.log('checkAdminPassword called');
    const password = document.getElementById('admin-password-input').value;
    const correctAdminPassword = 'AdminSecret2025';
    const errorEl = document.getElementById('admin-password-error');
    if (password === correctAdminPassword) {
        console.log('Password correct - showing admin content');
        document.getElementById('admin-password-prompt').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        
        // Load all data
        populateDynamicContactList();
        loadRSVPs();
        loadGuestListRequests();
        loadContacts();
        
        // Initialize forms now that they are visible
        if (typeof window.initializeContactForm === 'function') {
            window.initializeContactForm();
        }
        if (typeof window.initializeInviteForm === 'function') {
            window.initializeInviteForm();
        }
    } else {
        console.log('Password incorrect - showing error');
        errorEl.textContent = 'Incorrect admin password. Try again.';
        errorEl.style.color = 'red';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded fired');
    document.getElementById('admin-password-prompt').style.display = 'block';

    const adminPasswordForm = document.getElementById('admin-password-form');
    console.log('admin-password-form element:', adminPasswordForm);
    if (adminPasswordForm) {
        adminPasswordForm.addEventListener('submit', (e) => {
            e.preventDefault();
            console.log('Admin password form submitted');
            checkAdminPassword();
        });
    } else {
        console.error('admin-password-form not found in DOM');
    }
});