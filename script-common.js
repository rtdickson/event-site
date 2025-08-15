document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('authenticated') !== 'true') {
        window.location.href = 'index.html'; // Redirect to main if not authenticated
    }
});