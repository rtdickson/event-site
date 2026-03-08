// Theme definitions - all colors controlled via CSS custom properties
const themes = {
    default: {
        label: 'Default (Purple)',
        '--primary-dark': '#4a4e69',
        '--primary-medium': '#6b728e',
        '--background': '#f9f9f9',
        '--text-color': '#333'
    },
    ocean: {
        label: 'Ocean',
        '--primary-dark': '#00695c',
        '--primary-medium': '#00acc1',
        '--background': '#f0fdff',
        '--text-color': '#004d5c'
    },
    forest: {
        label: 'Forest',
        '--primary-dark': '#2e7d32',
        '--primary-medium': '#4caf50',
        '--background': '#f1f8e9',
        '--text-color': '#1b5e20'
    },
    sunset: {
        label: 'Sunset',
        '--primary-dark': '#d84315',
        '--primary-medium': '#ff7043',
        '--background': '#fff8f5',
        '--text-color': '#5d2c2c'
    },
    wine: {
        label: 'Wine Country',
        '--primary-dark': '#6a1b9a',
        '--primary-medium': '#8e24aa',
        '--background': '#fdf7f7',
        '--text-color': '#4a148c'
    },
    autumn: {
        label: 'Autumn',
        '--primary-dark': '#8d4004',
        '--primary-medium': '#bf6000',
        '--background': '#faf7f0',
        '--text-color': '#3e2723'
    },
    navy: {
        label: 'Navy',
        '--primary-dark': '#1a237e',
        '--primary-medium': '#3949ab',
        '--background': '#f5f5ff',
        '--text-color': '#1a237e'
    },
    slate: {
        label: 'Slate',
        '--primary-dark': '#37474f',
        '--primary-medium': '#607d8b',
        '--background': '#f5f5f5',
        '--text-color': '#263238'
    },
    spring: {
        label: 'Spring',
        '--primary-dark': '#558b2f',
        '--primary-medium': '#9ccc65',
        '--background': '#fdfff5',
        '--text-color': '#33691e'
    }
};

// Apply a theme by setting CSS custom properties on :root
function applyTheme(themeName) {
    const theme = themes[themeName];
    if (!theme) return;

    const root = document.documentElement;
    root.style.setProperty('--primary-dark', theme['--primary-dark']);
    root.style.setProperty('--primary-medium', theme['--primary-medium']);
    root.style.setProperty('--background', theme['--background']);
    root.style.setProperty('--text-color', theme['--text-color']);

    // Cache in localStorage for instant load on next visit
    localStorage.setItem('site_theme', themeName);
}

// Load theme: first from localStorage (instant), then confirm from Firestore
function loadTheme() {
    // 1. Apply cached theme immediately to avoid flash
    const cached = localStorage.getItem('site_theme');
    if (cached && themes[cached]) {
        applyTheme(cached);
    }

    // 2. Fetch from Firestore once db is available, update if different
    function fetchFromFirestore() {
        if (typeof db === 'undefined') {
            // db not ready yet, wait a bit
            setTimeout(fetchFromFirestore, 100);
            return;
        }
        db.collection('settings').doc('theme').get().then(doc => {
            if (doc.exists) {
                const themeName = doc.data().name;
                if (themeName && themes[themeName] && themeName !== cached) {
                    applyTheme(themeName);
                }
            }
        }).catch(err => {
            console.log('Could not load theme from Firestore:', err.message);
        });
    }
    fetchFromFirestore();
}

// Save theme to Firestore
function saveTheme(themeName) {
    applyTheme(themeName);
    if (typeof db !== 'undefined') {
        db.collection('settings').doc('theme').set({ name: themeName })
            .then(() => console.log('Theme saved:', themeName))
            .catch(err => console.error('Error saving theme:', err));
    }
}

// Auto-load theme when script runs
loadTheme();
