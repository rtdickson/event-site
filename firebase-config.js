// Shared Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDrunOzCIlX9iqYEhpWGqDlN8sUBaF44po",
    authDomain: "piveevents.firebaseapp.com",
    projectId: "piveevents",
    storageBucket: "piveevents.firebasestorage.app",
    messagingSenderId: "635106763509",
    appId: "1:635106763509:web:1f18f4e10da36177f0dbbc",
    measurementId: "G-2VW032KXE8"
};

// Initialize Firebase v10 (compat mode for easier migration)
firebase.initializeApp(firebaseConfig);

// Export commonly used services
const db = firebase.firestore();
// Remove storage initialization - only initialize it where needed (gallery)