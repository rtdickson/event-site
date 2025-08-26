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
const storage = firebase.storage();

document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('authenticated') !== 'true') {
        window.location.href = 'index.html'; // Redirect if not authenticated
    } else {
        loadGallery();
    }
});

async function uploadPhoto() {
    const file = document.getElementById('photo-input').files[0];
    if (!file) return;
    const messageEl = document.getElementById('upload-message');
    const storageRef = storage.ref(`gallery/${Date.now()}_${file.name}`);
    try {
        await storageRef.put(file);
        messageEl.textContent = 'Photo uploaded!';
        messageEl.style.color = 'green';
        document.getElementById('photo-input').value = '';
        loadGallery(); // Refresh gallery
    } catch (error) {
        messageEl.textContent = 'Error uploading photo. Try again.';
        messageEl.style.color = 'red';
    }
}

async function loadGallery() {
    const galleryGrid = document.getElementById('gallery-grid');
    galleryGrid.innerHTML = '';
    const listRef = storage.ref('gallery');
    try {
        const res = await listRef.listAll();
        for (const itemRef of res.items) {
            const url = await itemRef.getDownloadURL();
            const link = document.createElement('a');
            link.href = url;
            link.target = '_blank'; // Open in new window
            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Event Photo';
            link.appendChild(img);
            galleryGrid.appendChild(link);
        }
    } catch (error) {
        console.error('Error loading gallery:', error);
    }
}