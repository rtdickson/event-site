document.addEventListener('DOMContentLoaded', () => {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (sessionStorage.getItem('authenticated') !== 'true' && currentPage !== 'index.html') {
        window.location.href = 'index.html';
    }
});