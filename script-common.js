document.addEventListener('DOMContentLoaded', () => {
    // Only redirect if we're NOT on the index page
    if (window.location.pathname !== '/index.html' && !window.location.pathname.endsWith('/')) {
        // Use the new auth system instead of sessionStorage
        if (!window.auth || !window.auth.isAuthenticated()) {
            window.location.href = 'index.html';
        }
    }
});