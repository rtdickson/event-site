// Secure authentication module
console.log('auth.js loaded');

class SecureAuth {
    constructor() {
        this.TOKEN_KEY = 'auth_token';
        this.ROLE_KEY = 'user_role';
        // Per-role session length. Both roles persist across browser closes/refreshes;
        // admin auto-logout on unload was removed for usability (single-admin site).
        this.SESSION_DURATION_BY_ROLE = {
            guest: 30 * 24 * 60 * 60 * 1000, // 30 days — "verify once on your phone"
            admin: 30 * 24 * 60 * 60 * 1000  // 30 days — same; admin self-manages devices
        };
        this.DEFAULT_SESSION_DURATION = this.SESSION_DURATION_BY_ROLE.guest;
    }

    // Hash function for client-side password verification
    async hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // Validate password against stored hash
    async validatePassword(inputPassword, role) {
        const hashedInput = await this.hashPassword(inputPassword);
        
        // In production, these would come from a secure server endpoint
        const validHashes = {
            'guest': await this.hashPassword('FriendsOnly2025'),
            'admin': await this.hashPassword('AdminSecret2025')
        };

        return hashedInput === validHashes[role];
    }

    // Create session token
    createSessionToken(role) {
        const ttl = this.SESSION_DURATION_BY_ROLE[role] || this.DEFAULT_SESSION_DURATION;
        const sessionData = {
            role: role,
            timestamp: Date.now(),
            expires: Date.now() + ttl,
            sessionId: crypto.randomUUID()
        };

        // In production, this would be a JWT or similar secure token
        return btoa(JSON.stringify(sessionData));
    }

    // Validate session token
    validateSession() {
        const token = localStorage.getItem(this.TOKEN_KEY);
        if (!token) return null;

        try {
            const sessionData = JSON.parse(atob(token));
            
            // Check if session has expired
            if (Date.now() > sessionData.expires) {
                this.logout();
                return null;
            }

            return sessionData;
        } catch (error) {
            console.error('Invalid session token:', error);
            this.logout();
            return null;
        }
    }

    // Login method
    async login(password, role = 'guest') {
        const isValid = await this.validatePassword(password, role);
        
        if (isValid) {
            const token = this.createSessionToken(role);
            localStorage.setItem(this.TOKEN_KEY, token);
            localStorage.setItem(this.ROLE_KEY, role);
            return true;
        }
        
        return false;
    }

    // Logout method
    logout() {
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.ROLE_KEY);
        sessionStorage.clear();
    }

    // Check if user is authenticated
    isAuthenticated() {
        return this.validateSession() !== null;
    }

    // Get current user role
    getCurrentRole() {
        const session = this.validateSession();
        return session ? session.role : null;
    }

    // Check if user has specific role
    hasRole(requiredRole) {
        const currentRole = this.getCurrentRole();
        return currentRole === requiredRole || (requiredRole === 'guest' && currentRole === 'admin');
    }

    // Redirect if not authenticated
    requireAuth(requiredRole = 'guest') {
        if (!this.isAuthenticated()) {
            window.location.href = 'index.html';
            return false;
        }

        if (requiredRole && !this.hasRole(requiredRole)) {
            alert('Access denied. Insufficient permissions.');
            window.location.href = 'index.html';
            return false;
        }

        return true;
    }

    // Initialize authentication for a page.
    // Admin auto-logout-on-unload was removed (2026-05-17) — single-admin site,
    // the constant retyping was a tax with no real security benefit. 30-day TTL
    // applies and the logout button is always available in the header.
    initAuth(requiredRole = 'guest') {
        return this.requireAuth(requiredRole);
    }
}

// Create global auth instance
window.auth = new SecureAuth();

// Enhanced password checking with better UX
async function checkPassword(role = 'guest') {
    const passwordInput = document.getElementById('password-input');
    const errorEl = document.getElementById('password-error');
    const submitButton = document.querySelector('button[onclick="checkPassword()"]');
    
    if (!passwordInput || !passwordInput.value) {
        errorEl.textContent = 'Please enter a password.';
        return;
    }

    // Show loading state
    submitButton.disabled = true;
    submitButton.textContent = 'Verifying...';
    errorEl.textContent = '';

    try {
        const isValid = await window.auth.login(passwordInput.value, role);
        
        if (isValid) {
            // Success - redirect or show content
            document.getElementById('password-prompt').style.display = 'none';
            document.getElementById('main-content').style.display = 'block';
            
            // Call page-specific initialization if it exists
            if (typeof initializePage === 'function') {
                initializePage();
            }
        } else {
            errorEl.textContent = 'Incorrect password. Please try again.';
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (error) {
        console.error('Authentication error:', error);
        errorEl.textContent = 'Authentication failed. Please try again.';
    } finally {
        // Reset button state
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
}

// Admin password checking
async function checkAdminPassword() {
    const passwordInput = document.getElementById('admin-password-input');
    const errorEl = document.getElementById('admin-password-error');
    
    if (!passwordInput || !passwordInput.value) {
        errorEl.textContent = 'Please enter the admin password.';
        return;
    }

    try {
        const isValid = await window.auth.login(passwordInput.value, 'admin');
        
        if (isValid) {
            document.getElementById('admin-password-prompt').style.display = 'none';
            document.getElementById('admin-content').style.display = 'block';
            
            // Initialize admin functionality
            if (typeof initializeAdmin === 'function') {
                initializeAdmin();
            }
        } else {
            errorEl.textContent = 'Incorrect admin password. Access denied.';
            passwordInput.value = '';
        }
    } catch (error) {
        console.error('Admin authentication error:', error);
        errorEl.textContent = 'Authentication failed. Please try again.';
    }
}

// Logout functionality
function logout() {
    window.auth.logout();
    window.location.href = 'index.html';
}

// Add logout link to authenticated pages.
// Prefers a #header-actions container if the page provides one (admin); otherwise
// pins to the top-right of the page header as a subtle text link.
document.addEventListener('DOMContentLoaded', () => {
    if (!window.auth.isAuthenticated()) return;

    const logoutLink = document.createElement('a');
    logoutLink.href = '#';
    logoutLink.textContent = 'Logout';
    logoutLink.className = 'site-logout-link';
    logoutLink.addEventListener('click', (e) => { e.preventDefault(); logout(); });

    const slot = document.getElementById('header-actions');
    if (slot) {
        slot.appendChild(logoutLink);
        return;
    }

    // Fallback: pin to top-right of the page header
    const header = document.querySelector('header') || document.querySelector('main');
    if (!header) return;
    logoutLink.classList.add('site-logout-link-floating');
    header.style.position = 'relative';
    header.appendChild(logoutLink);
});