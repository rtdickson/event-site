const db = firebase.firestore();

// Helper function to normalize phone numbers for comparison
function normalizePhone(phone) {
    if (!phone) return '';
    // Remove all non-digit characters and ensure we have just the numbers
    const cleaned = phone.replace(/\D/g, '');
    // If it starts with 1 and is 11 digits, return last 10 digits for comparison
    // If it's 10 digits, return as is
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        return cleaned.slice(1);
    }
    return cleaned;
}

// Add this function to get invite status for a contact
async function getContactInviteStatus(phone, eventName) {
    try {
        // Check if they have an RSVP for this event
        const rsvpSnapshot = await db.collection(`rsvps-${eventName}`)
            .where('phone', '==', phone)
            .limit(1)
            .get();
        
        if (!rsvpSnapshot.empty) {
            const rsvpData = rsvpSnapshot.docs[0].data();
            return {
                status: 'responded',
                attending: rsvpData.attending,
                lastActivity: rsvpData.timestamp
            };
        }
        
        // Check if they were invited recently (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        const inviteSnapshot = await db.collection('invites')
            .where('phone', '==', phone)
            .where('eventName', '==', eventName)
            .where('timestamp', '>', sevenDaysAgo)
            .limit(1)
            .get();
        
        if (!inviteSnapshot.empty) {
            return {
                status: 'invited_no_response',
                lastActivity: inviteSnapshot.docs[0].data().timestamp
            };
        }
        
        return { status: 'not_invited' };
    } catch (error) {
        console.error('Error getting invite status:', error);
        return { status: 'unknown' };
    }
}

// Enhanced version of populateDynamicContactList with invite status
async function populateDynamicContactList() {
    const listContainer = document.getElementById('dynamic-contact-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    
    // Get selected event for status checking
    const selectedEvent = document.getElementById('event-select').value;
    
    try {
        const snapshot = await db.collection('contacts').orderBy('timestamp', 'desc').get();
        
        // Add control buttons at the top
        const headerDiv = document.createElement('div');
        headerDiv.className = 'contact-list-header';
        headerDiv.innerHTML = `
            <div style="display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
                <button onclick="addSelectedToInvite()" style="background-color: #4CAF50; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Add Selected</button>
                <button onclick="selectAllContacts()" style="background-color: #2196F3; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Select All</button>
                <button onclick="clearAllContacts()" style="background-color: #f44336; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Clear All</button>
                <button onclick="selectNotInvited()" style="background-color: #FF9800; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Select Not Invited</button>
            </div>
            <div style="font-size: 12px; color: #666; margin-bottom: 10px;">
                Status: <span style="color: #4CAF50;">●</span> RSVP'd | <span style="color: #FF9800;">●</span> Invited, no response | <span style="color: #999;">●</span> Not invited
            </div>
        `;
        listContainer.appendChild(headerDiv);

        // Process contacts and get their invite status
        const contactPromises = [];
        const contacts = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            contacts.push({ id: doc.id, data });
            contactPromises.push(getContactInviteStatus(data.phone, selectedEvent));
        });
        
        const statuses = await Promise.all(contactPromises);
        
        contacts.forEach((contact, index) => {
            const data = contact.data;
            const status = statuses[index];
            
            let statusIndicator = '';
            let statusColor = '#999';
            let statusTitle = 'Not invited';
            
            switch (status.status) {
                case 'responded':
                    statusColor = '#4CAF50';
                    statusIndicator = `RSVP: ${status.attending}`;
                    statusTitle = `RSVP'd ${status.attending}`;
                    break;
                case 'invited_no_response':
                    statusColor = '#FF9800';
                    statusIndicator = 'Invited';
                    statusTitle = 'Invited, no response yet';
                    break;
                case 'not_invited':
                default:
                    statusColor = '#999';
                    statusIndicator = '';
                    statusTitle = 'Not invited to this event';
                    break;
            }
            
            const contactDiv = document.createElement('div');
            contactDiv.className = 'contact-entry';
            contactDiv.setAttribute('data-status', status.status);
            contactDiv.style.cssText = 'display: flex; align-items: center; margin-bottom: 8px; padding: 6px; border: 1px solid #ddd; border-radius: 4px;';
            contactDiv.innerHTML = `
                <input type="checkbox" id="contact-${contact.id}" value="${data.phone}" style="margin-right: 8px;" />
                <div style="width: 12px; height: 12px; border-radius: 50%; background-color: ${statusColor}; margin-right: 8px; flex-shrink: 0;" title="${statusTitle}"></div>
                <label for="contact-${contact.id}" style="flex: 1; cursor: pointer;">
                    <strong>${data.name}</strong>: ${data.phone}
                    ${statusIndicator ? `<span style="font-size: 11px; color: ${statusColor}; margin-left: 8px;">${statusIndicator}</span>` : ''}
                </label>
                <button onclick="addToInvite('${data.phone}')" style="background: none; border: none; font-size: 18px; color: #4CAF50; cursor: pointer; padding: 4px;" title="Add to invite">+</button>
            `;
            listContainer.appendChild(contactDiv);
        });
    } catch (error) {
        console.error('Error loading dynamic contact list:', error);
    }
}

function addToInvite(phone) {
    const inputField = document.getElementById('phone-numbers');
    if (inputField.value.trim() === '') {
        inputField.value = phone;
    } else {
        // Check if phone number is already in the list to avoid duplicates
        const existingNumbers = inputField.value.split(',').map(num => num.trim());
        if (!existingNumbers.includes(phone)) {
            inputField.value += ',' + phone;
        }
    }
}

function addSelectedToInvite() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list input[type="checkbox"]:checked');
    const inputField = document.getElementById('phone-numbers');
    
    if (checkboxes.length === 0) {
        alert('Please select at least one contact to add.');
        return;
    }
    
    const selectedNumbers = Array.from(checkboxes).map(cb => cb.value);
    const existingNumbers = inputField.value.trim() === '' ? [] : inputField.value.split(',').map(num => num.trim());
    
    // Filter out duplicates
    const newNumbers = selectedNumbers.filter(num => !existingNumbers.includes(num));
    
    if (newNumbers.length === 0) {
        alert('All selected contacts are already in the invite list.');
        return;
    }
    
    // Add new numbers
    if (inputField.value.trim() === '') {
        inputField.value = newNumbers.join(',');
    } else {
        inputField.value += ',' + newNumbers.join(',');
    }
    
    // Uncheck all checkboxes
    checkboxes.forEach(cb => cb.checked = false);
}

function selectAllContacts() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
}

function clearAllContacts() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
}

// New function to select contacts that haven't been invited
function selectNotInvited() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list input[type="checkbox"]');
    checkboxes.forEach(cb => {
        const contactDiv = cb.closest('.contact-entry');
        if (contactDiv && contactDiv.getAttribute('data-status') === 'not_invited') {
            cb.checked = true;
        }
    });
}

// Update the event selector to refresh contact list when changed
function onEventChange() {
    populateDynamicContactList();
}

async function loadRSVPs() {
    console.log('=== Starting loadRSVPs function ===');
    const groupsDiv = document.getElementById('rsvp-groups');
    groupsDiv.innerHTML = '';
    const events = ['dinner-party', 'fall-picnic', 'halloween-party'];

    // Load contacts for name lookup
    const contactsMap = new Map();
    try {
        console.log('Loading contacts for name lookup...');
        const contactsSnapshot = await db.collection('contacts').get();
        console.log(`Found ${contactsSnapshot.size} contacts`);
        
        contactsSnapshot.forEach(doc => {
            const data = doc.data();
            console.log('Contact data:', data);
            const normalizedPhone = normalizePhone(data.phone);
            if (data.phone) {
                // Store both the original and normalized versions
                contactsMap.set(data.phone, data.name);
                if (normalizedPhone && normalizedPhone !== data.phone) {
                    contactsMap.set(normalizedPhone, data.name);
                }
                console.log(`Added contact: ${data.name} -> ${data.phone} (normalized: ${normalizedPhone})`);
            }
        });
        console.log('Final contacts map:', Object.fromEntries(contactsMap));
    } catch (error) {
        console.error('Error loading contacts for name lookup:', error);
    }

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
            console.log(`Loading RSVPs for event: ${eventName}`);
            const snapshot = await db.collection(`rsvps-${eventName}`).orderBy('timestamp', 'desc').get();
            console.log(`Found ${snapshot.size} RSVPs for ${eventName}`);
            
            snapshot.forEach(doc => {
                const data = doc.data();
                console.log(`=== Processing RSVP for ${eventName} ===`);
                console.log('RSVP data:', data);
                console.log('RSVP name:', data.name);
                console.log('RSVP phone:', data.phone);
                
                // Look up name from contacts if name is "Unknown", "Unknown (SMS)", or empty but we have a phone
                let displayName = data.name;
                const shouldLookup = (
                    data.name === 'Unknown' || 
                    data.name === 'Unknown (SMS)' || 
                    !data.name || 
                    data.name.trim() === '' ||
                    data.name.toLowerCase().includes('unknown')
                );
                console.log(`Should lookup name? ${shouldLookup} (name: "${data.name}", has phone: ${!!data.phone})`);
                
                if (shouldLookup && data.phone) {
                    console.log(`Attempting lookup for phone: "${data.phone}"`);
                    // Try exact match first
                    if (contactsMap.has(data.phone)) {
                        displayName = contactsMap.get(data.phone);
                        console.log(`✓ Found exact match for ${data.phone}: ${displayName}`);
                    } else {
                        // Try normalized match
                        const normalizedRSVPPhone = normalizePhone(data.phone);
                        console.log(`Trying normalized lookup: "${normalizedRSVPPhone}"`);
                        if (normalizedRSVPPhone && contactsMap.has(normalizedRSVPPhone)) {
                            displayName = contactsMap.get(normalizedRSVPPhone);
                            console.log(`✓ Found normalized match for ${data.phone} (${normalizedRSVPPhone}): ${displayName}`);
                        } else {
                            console.log(`✗ No match found for phone: "${data.phone}" (normalized: "${normalizedRSVPPhone}")`);
                            console.log('Available phones in contacts:', Array.from(contactsMap.keys()));
                        }
                    }
                } else {
                    console.log('Skipping lookup - using existing name or no phone available');
                }
                console.log(`Final display name: "${displayName}"`);
                
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${displayName || 'Unknown'}</td>
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
    console.log('=== Finished loadRSVPs function ===');
}

async function deleteRSVP(id, collectionName) {
    if (confirm('Delete this RSVP?')) {
        try {
            await db.collection(collectionName).doc(id).delete();
            loadRSVPs();
            // Refresh contact list to update status
            populateDynamicContactList();
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
            // Refresh contact list to update status
            populateDynamicContactList();
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

async function loadContacts() {
    const tableBody = document.getElementById('contact-table').querySelector('tbody');
    tableBody.innerHTML = '';
    try {
        const snapshot = await db.collection('contacts').orderBy('timestamp', 'desc').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${data.name || ''}</td>
                <td>${data.phone}</td>
                <td><button onclick="deleteContact('${doc.id}')">Delete</button></td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

async function deleteContact(id) {
    if (confirm('Delete this contact?')) {
        try {
            await db.collection('contacts').doc(id).delete();
            loadContacts();
            // Refresh the dynamic contact list as well
            populateDynamicContactList();
        } catch (error) {
            console.error('Error deleting contact:', error);
        }
    }
}

function checkAdminPassword() {
    console.log('checkAdminPassword called');
    const password = document.getElementById('admin-password-input').value;
    const correctAdminPassword = 'AdminSecret2025';
    const errorEl = document.getElementById('admin-password-error');
    if (password === correctAdminPassword) {
        console.log('Password correct - showing admin content');
        document.getElementById('admin-password-prompt').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        
        // Load all data
        populateDynamicContactList();
        loadRSVPs();
        loadGuestListRequests();
        loadContacts();
        
        // Add event change listener
        const eventSelect = document.getElementById('event-select');
        if (eventSelect) {
            eventSelect.addEventListener('change', onEventChange);
        }
        
        // Initialize forms now that they are visible
        if (typeof window.initializeContactForm === 'function') {
            window.initializeContactForm();
        }
        if (typeof window.initializeInviteForm === 'function') {
            window.initializeInviteForm();
        }
    } else {
        console.log('Password incorrect - showing error');
        errorEl.textContent = 'Incorrect admin password. Try again.';
        errorEl.style.color = 'red';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded fired');
    document.getElementById('admin-password-prompt').style.display = 'block';

    const adminPasswordForm = document.getElementById('admin-password-form');
    console.log('admin-password-form element:', adminPasswordForm);
    if (adminPasswordForm) {
        adminPasswordForm.addEventListener('submit', (e) => {
            e.preventDefault();
            console.log('Admin password form submitted');
            checkAdminPassword();
        });
    } else {
        console.error('admin-password-form not found in DOM');
    }
});