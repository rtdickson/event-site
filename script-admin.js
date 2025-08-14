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
    const correctAdminPassword = 'Admin2025'; // Special admin password
    const errorEl = document.getElementById('admin-password-error');
    if (password === correctAdminPassword) {
        document.getElementById('admin-password-prompt').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        loadRSVPs();
    } else {
        errorEl.textContent = 'Incorrect admin password. Try again.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('admin-password-prompt').style.display = 'block';
});

async function loadRSVPs() {
    const tableBody = document.getElementById('rsvp-table').querySelector('tbody');
    tableBody.innerHTML = '';
    try {
        const snapshot = await db.collection('rsvps').orderBy('timestamp', 'desc').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${data.name}</td>
                <td>${data.attending}</td>
                <td>${data.guests}</td>
                <td>${data.bringing || ''}</td>
                <td>${data.notes || ''}</td>
                <td>${data.timestamp ? data.timestamp.toDate().toLocaleString() : ''}</td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading RSVPs:', error);
    }
}