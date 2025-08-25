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

function checkAdminPassword() {
    const password = document.getElementById('admin-password-input').value;
    const correctAdminPassword = 'AdminSecret2025'; // Special admin password
    const errorEl = document.getElementById('admin-password-error');
    if (password === correctAdminPassword) {
        document.getElementById('admin-password-prompt').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        loadRSVPs();
        loadGuestListRequests();
    } else {
        errorEl.textContent = 'Incorrect admin password. Try again.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('admin-password-prompt').style.display = 'block';
});

async function loadRSVPs() {
    const groupsDiv = document.getElementById('rsvp-groups');
    groupsDiv.innerHTML = '';
    const events = ['dinner-party', 'fall-picnic', 'halloween-party']; // Add your event names here

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