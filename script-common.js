document.addEventListener('DOMContentLoaded', () => {
    // Only redirect if we're NOT on the index page
    if (window.location.pathname !== '/index.html' && !window.location.pathname.endsWith('/')) {
        if (sessionStorage.getItem('authenticated') !== 'true') {
            window.location.href = 'index.html';
        }
    }
});