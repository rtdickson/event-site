// Firebase database reference (initialized in firebase-config.js)
// const db is available globally from firebase-config.js

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

// Helper function to create collection name from event name
function createCollectionName(eventName) {
    return 'rsvps-' + eventName.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with dashes
        .replace(/-+/g, '-') // Replace multiple dashes with single dash
        .replace(/^-|-$/g, ''); // Remove leading/trailing dashes
}

// Combined event change handler - SINGLE SOURCE OF TRUTH
function handleEventChange() {
    updateDefaultMessage();
    populateDynamicContactList();
    updateRSVPOnlyContactList(); // New function
}

// Initialize admin functionality - called by auth system
async function initializeAdmin() {
    console.log('initializeAdmin called'); // Debug line
    
    // Load all data with proper sequencing - AWAIT each one
    await loadEvents();
    await loadEventOptions(); // Make sure this completes before moving on
    console.log('loadEventOptions completed'); // Debug line
    
    loadRSVPs(); // These can run async
    loadGuestListRequests();

    // Set up initial dynamic content and event listener after everything loads
    setTimeout(() => {
        console.log('Setting up event listeners'); // Debug line
        setupEventChangeListener();
        handleEventChange();
    }, 1000); // Increased delay to 1 second
    
    // Initialize forms now that they are visible
    if (typeof window.initializeContactForm === 'function') {
        window.initializeContactForm();
    }
    if (typeof window.initializeInviteForm === 'function') {
        window.initializeInviteForm();
    }
}

// Event management functions
async function loadEvents() {
    const eventsList = document.getElementById('events-list');
    eventsList.innerHTML = 'Loading events...';
    
    try {
        const snapshot = await db.collection('events').orderBy('createdAt', 'desc').get();
        eventsList.innerHTML = '';
        
        if (snapshot.empty) {
            eventsList.innerHTML = '<p>No events created yet.</p>';
            return;
        }
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const eventDiv = document.createElement('div');
            eventDiv.className = 'event-item';
            eventDiv.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>${data.name}</strong>
                        ${data.isActive ? '<span style="color: green; font-weight: bold;"> (ACTIVE)</span>' : ''}
                        <div style="font-size: 12px; color: #666;">${data.date}</div>
                        <div style="font-size: 12px; color: #666;">Collection: ${data.collectionName}</div>
                    </div>
                    <div>
                        <button class="edit-btn" onclick="editEvent('${doc.id}')">Edit</button>
                        <button class="delete-btn" onclick="deleteEvent('${doc.id}')">Delete</button>
                    </div>
                </div>
            `;
            eventsList.appendChild(eventDiv);
        });
    } catch (error) {
        console.error('Error loading events:', error);
        eventsList.innerHTML = '<p style="color: red;">Error loading events.</p>';
    }
}

async function saveEvent(eventData, eventId = null) {
    try {
        // If setting this event as active, deactivate all others first
        if (eventData.isActive) {
            const activeSnapshot = await db.collection('events').where('isActive', '==', true).get();
            const batch = db.batch();
            activeSnapshot.docs.forEach(doc => {
                batch.update(doc.ref, { isActive: false });
            });
            await batch.commit();
        }
        
        if (eventId) {
            // Update existing event
            await db.collection('events').doc(eventId).update(eventData);
        } else {
            // Create new event
            eventData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            await db.collection('events').add(eventData);
        }
        
        return true;
    } catch (error) {
        console.error('Error saving event:', error);
        return false;
    }
}

async function editEvent(eventId) {
    try {
        const doc = await db.collection('events').doc(eventId).get();
        if (!doc.exists) return;
        
        const data = doc.data();
        
        // Populate form with event data
        document.getElementById('event-name').value = data.name || '';
        document.getElementById('event-date').value = data.date || '';
        document.getElementById('event-description').value = data.description || '';
        document.getElementById('event-menu').value = Array.isArray(data.menu) ? data.menu.join('\n') : '';
        document.getElementById('event-bring').value = data.whatToBring || '';
        document.getElementById('event-schedule').value = Array.isArray(data.schedule) ? data.schedule.join('\n') : '';
        document.getElementById('event-active').checked = data.isActive || false;
        
        // Store the event ID for updating
        document.getElementById('event-form').setAttribute('data-edit-id', eventId);
        
        // Change button text
        const submitButton = document.querySelector('#event-form button[type="submit"]');
        submitButton.textContent = 'Update Event';
        
    } catch (error) {
        console.error('Error loading event for editing:', error);
    }
}

async function deleteEvent(eventId) {
    if (confirm('Delete this event? This will also delete all RSVPs for this event.')) {
        try {
            // Get the event to find its collection name
            const eventDoc = await db.collection('events').doc(eventId).get();
            const eventData = eventDoc.data();
            
            // Delete the event
            await db.collection('events').doc(eventId).delete();
            
            // Delete associated RSVPs
            if (eventData.collectionName) {
                const rsvpSnapshot = await db.collection(eventData.collectionName).get();
                const batch = db.batch();
                rsvpSnapshot.docs.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();
            }
            
            loadEvents();
            loadEventOptions(); // Refresh dropdown
            document.getElementById('event-message').textContent = 'Event deleted successfully.';
            document.getElementById('event-message').style.color = 'green';
        } catch (error) {
            console.error('Error deleting event:', error);
            document.getElementById('event-message').textContent = 'Error deleting event.';
            document.getElementById('event-message').style.color = 'red';
        }
    }
}

function clearEventForm() {
    document.getElementById('event-form').reset();
    document.getElementById('event-form').removeAttribute('data-edit-id');
    document.querySelector('#event-form button[type="submit"]').textContent = 'Save Event';
    document.getElementById('event-message').textContent = '';
}

async function loadEventOptions() {
    console.log('=== loadEventOptions START ===');
    try {
        const eventSelect = document.getElementById('event-select');
        console.log('eventSelect element:', eventSelect);
        
        if (!eventSelect) {
            console.log('ERROR: event-select element not found!');
            return;
        }
        
        console.log('Querying events...');
        const snapshot = await db.collection('events').orderBy('createdAt', 'desc').get();
        console.log('Events found:', snapshot.size);
        
        // Clear existing options
        eventSelect.innerHTML = '';
        
        if (snapshot.empty) {
            console.log('No events in database');
            eventSelect.innerHTML = '<option value="">No events created yet</option>';
            return;
        }

        // Find active event
        const activeEvent = snapshot.docs.find(doc => doc.data().isActive);
        console.log('Active event found:', activeEvent ? activeEvent.data().name : 'none');
        
        // Add special RSVP-only option for active event first
        if (activeEvent) {
            const activeData = activeEvent.data();
            const option = document.createElement('option');
            option.value = `rsvp-only-${activeData.collectionName}`;
            option.textContent = `${activeData.name} - RSVP'd Only (Yes/Maybe)`;
            option.setAttribute('data-event-name', activeData.name);
            option.setAttribute('data-is-rsvp-only', 'true');
            eventSelect.appendChild(option);
            console.log('Added RSVP-only option:', option.textContent);
            
            // Add a separator
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '──────────────────';
            eventSelect.appendChild(separator);
        }
        
        // Add regular event options
        snapshot.forEach(doc => {
            const data = doc.data();
            const option = document.createElement('option');
            option.value = data.collectionName.replace('rsvps-', '');
            option.textContent = data.name;
            option.setAttribute('data-event-name', data.name);
            option.setAttribute('data-is-rsvp-only', 'false');
            if (data.isActive) {
                option.textContent += ' (ACTIVE)';
                // Don't auto-select if we have RSVP option
                if (!activeEvent) {
                    option.selected = true;
                }
            }
            eventSelect.appendChild(option);
            console.log('Added regular option:', option.textContent);
        });
        
        console.log('Final dropdown HTML:', eventSelect.innerHTML);
        
    } catch (error) {
        console.error('Error in loadEventOptions:', error);
    }
    console.log('=== loadEventOptions END ===');
}
// 3. Add new function to populate contact list with RSVP'd attendees
async function updateRSVPOnlyContactList() {
    const eventSelect = document.getElementById('event-select');
    const listContainer = document.getElementById('dynamic-contact-list');
    
    if (!eventSelect || !listContainer) return;
    
    const selectedOption = eventSelect.options[eventSelect.selectedIndex];
    const isRSVPOnly = selectedOption && selectedOption.getAttribute('data-is-rsvp-only') === 'true';
    
    if (!isRSVPOnly) return; // Regular contact list handling
    
    // Show loading for RSVP-only list
    listContainer.innerHTML = '<p>Loading RSVP attendees...</p>';
    
    try {
        // Extract collection name from the value
        const selectedValue = eventSelect.value;
        const collectionName = selectedValue.replace('rsvp-only-', '');
        
        // Get RSVPs with Yes or Maybe
        const rsvpSnapshot = await db.collection(collectionName)
            .where('attending', 'in', ['Yes', 'Maybe'])
            .get();
        
        if (rsvpSnapshot.empty) {
            listContainer.innerHTML = '<p>No confirmed attendees yet for this event.</p>';
            return;
        }
        
        // Build RSVP contact list
        listContainer.innerHTML = '';
        const headerDiv = document.createElement('div');
        headerDiv.className = 'contact-list-header';
        headerDiv.innerHTML = `
            <div style="display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
                <button onclick="addSelectedRSVPsToInvite()" style="background-color: #4CAF50; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Add Selected</button>
                <button onclick="selectAllRSVPs()" style="background-color: #2196F3; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Select All</button>
                <button onclick="clearAllRSVPs()" style="background-color: #f44336; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Clear All</button>
            </div>
            <div style="font-size: 12px; color: #666; margin-bottom: 10px;">
                Showing attendees who RSVP'd Yes or Maybe to this event (${rsvpSnapshot.size} people)
            </div>
        `;
        listContainer.appendChild(headerDiv);
        
        // Load contacts for name lookup
        const contactsMap = new Map();
        try {
            const contactsSnapshot = await db.collection('contacts').get();
            contactsSnapshot.forEach(doc => {
                const data = doc.data();
                const normalizedPhone = normalizePhone(data.phone);
                if (data.phone) {
                    contactsMap.set(data.phone, data.name);
                    if (normalizedPhone && normalizedPhone !== data.phone) {
                        contactsMap.set(normalizedPhone, data.name);
                    }
                }
            });
        } catch (error) {
            console.error('Error loading contacts for RSVP lookup:', error);
        }
        
        // Add each RSVP attendee
        rsvpSnapshot.forEach(doc => {
            const rsvpData = doc.data();
            
            // Try to get name from contacts, fall back to RSVP name
            let displayName = rsvpData.name;
            if (rsvpData.phone && contactsMap.has(rsvpData.phone)) {
                displayName = contactsMap.get(rsvpData.phone);
            } else if (rsvpData.phone) {
                const normalizedPhone = normalizePhone(rsvpData.phone);
                if (normalizedPhone && contactsMap.has(normalizedPhone)) {
                    displayName = contactsMap.get(normalizedPhone);
                }
            }
            
            const statusColor = rsvpData.attending === 'Yes' ? '#4CAF50' : '#FF9800';
            const guestText = rsvpData.guests > 1 ? ` (+${rsvpData.guests - 1} guests)` : '';
            
            const contactDiv = document.createElement('div');
            contactDiv.className = 'contact-entry rsvp-entry';
            contactDiv.style.cssText = 'display: flex; align-items: center; margin-bottom: 8px; padding: 6px; border: 1px solid #ddd; border-radius: 4px;';
            contactDiv.innerHTML = `
                <input type="checkbox" id="rsvp-${doc.id}" value="${rsvpData.phone}" style="margin-right: 8px;" />
                <div style="width: 12px; height: 12px; border-radius: 50%; background-color: ${statusColor}; margin-right: 8px; flex-shrink: 0;" title="RSVP: ${rsvpData.attending}"></div>
                <label for="rsvp-${doc.id}" style="flex: 1; cursor: pointer;">
                    <strong>${displayName || 'Unknown'}</strong>: ${rsvpData.phone || 'No phone'}
                    <span style="font-size: 11px; color: ${statusColor}; margin-left: 8px;">${rsvpData.attending}${guestText}</span>
                </label>
                <button onclick="addToInvite('${rsvpData.phone}')" style="background: none; border: none; font-size: 18px; color: #4CAF50; cursor: pointer; padding: 4px;" title="Add to invite">+</button>
            `;
            listContainer.appendChild(contactDiv);
        });
        
    } catch (error) {
        console.error('Error loading RSVP attendees:', error);
        listContainer.innerHTML = '<p style="color: red;">Error loading RSVP attendees.</p>';
    }
}

// 4. Add helper functions for RSVP selection
function addSelectedRSVPsToInvite() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list .rsvp-entry input[type="checkbox"]:checked');
    const inputField = document.getElementById('phone-numbers');
    
    if (checkboxes.length === 0) {
        alert('Please select at least one attendee to add.');
        return;
    }
    
    const selectedNumbers = Array.from(checkboxes).map(cb => cb.value).filter(val => val && val !== 'No phone');
    const existingNumbers = inputField.value.trim() === '' ? [] : inputField.value.split(',').map(num => num.trim());
    
    // Filter out duplicates and invalid numbers
    const newNumbers = selectedNumbers.filter(num => num && !existingNumbers.includes(num));
    
    if (newNumbers.length === 0) {
        alert('All selected attendees are already in the invite list or have no phone numbers.');
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

function selectAllRSVPs() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list .rsvp-entry input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
}

function clearAllRSVPs() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list .rsvp-entry input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
}

// Set up event listener for dropdown changes
function setupEventChangeListener() {
    const eventSelect = document.getElementById('event-select');
    if (!eventSelect) return;
    
    // Remove any existing listeners first
    eventSelect.removeEventListener('change', handleEventChange);
    
    // Add the new listener
    eventSelect.addEventListener('change', handleEventChange);
}

// 5. Update the updateDefaultMessage function to handle RSVP-only messaging
function updateDefaultMessage() {
    const eventSelect = document.getElementById('event-select');
    const messageTextarea = document.getElementById('invite-message');
    
    if (!eventSelect || !messageTextarea) return;
    
    const selectedOption = eventSelect.options[eventSelect.selectedIndex];
    const eventName = selectedOption ? selectedOption.getAttribute('data-event-name') : null;
    const isRSVPOnly = selectedOption && selectedOption.getAttribute('data-is-rsvp-only') === 'true';
    
    if (eventName && eventName !== 'No events created yet') {
        let defaultMessage;
        
        if (isRSVPOnly) {
            // Special message for RSVP'd attendees
            defaultMessage = `Hi! Quick update about ${eventName}:

[Your update message here - maybe last minute details, timing changes, what to bring, etc.]

Thanks for confirming your attendance! See you there!`;
        } else {
            // Regular invitation message
            defaultMessage = `You're invited to ${eventName} at Pine Grove Gatherings!

RSVP options:
• Reply to this text: YES [# of guests], MAYBE [# of guests], or NO  
• Or visit https://75pinegrove.com (password: FriendsOnly2025)`;
        }
        
        messageTextarea.value = defaultMessage;
    }
}

// Get invite status for a contact
async function getContactInviteStatus(phone, eventName) {
    try {
        const normalizedContactPhone = normalizePhone(phone);
        
        // Check if they have an RSVP for this event
        let rsvpSnapshot = await db.collection(`rsvps-${eventName}`)
            .where('phone', '==', phone)
            .limit(1)
            .get();
        
        // If no exact match, try to find by normalized phone
        if (rsvpSnapshot.empty && normalizedContactPhone) {
            const allRSVPs = await db.collection(`rsvps-${eventName}`).get();
            
            for (const doc of allRSVPs.docs) {
                const rsvpData = doc.data();
                if (normalizePhone(rsvpData.phone) === normalizedContactPhone) {
                    rsvpSnapshot = { empty: false, docs: [doc] };
                    break;
                }
            }
        }
        
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
        
        let inviteSnapshot = await db.collection('invites')
            .where('phone', '==', phone)
            .where('eventName', '==', eventName)
            .where('timestamp', '>', sevenDaysAgo)
            .limit(1)
            .get();
        
        // If no exact match, try normalized phone for invites
        if (inviteSnapshot.empty && normalizedContactPhone) {
            const allInvites = await db.collection('invites')
                .where('eventName', '==', eventName)
                .where('timestamp', '>', sevenDaysAgo)
                .get();
            
            for (const doc of allInvites.docs) {
                const inviteData = doc.data();
                if (normalizePhone(inviteData.phone) === normalizedContactPhone) {
                    inviteSnapshot = { empty: false, docs: [doc] };
                    break;
                }
            }
        }
        
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
let isPopulatingContactList = false; // Flag to prevent overlapping calls

// 6. Update the populateDynamicContactList function to handle both cases
async function populateDynamicContactList() {
    // Prevent overlapping calls
    if (isPopulatingContactList) {
        return;
    }
    isPopulatingContactList = true;
    
    const listContainer = document.getElementById('dynamic-contact-list');
    const eventSelect = document.getElementById('event-select');
    
    if (!listContainer || !eventSelect) {
        isPopulatingContactList = false;
        return;
    }

    const selectedOption = eventSelect.options[eventSelect.selectedIndex];
    const isRSVPOnly = selectedOption && selectedOption.getAttribute('data-is-rsvp-only') === 'true';
    
    if (isRSVPOnly) {
        // Handle RSVP-only list - DON'T call updateRSVPOnlyContactList here
        // It will be called separately by handleEventChange()
        isPopulatingContactList = false;
        return; // Exit early and let updateRSVPOnlyContactList handle it
    }
    
    // Original contact list logic continues here ONLY for non-RSVP selections
    listContainer.innerHTML = '<p>Loading contacts...</p>';
    
    const selectedEvent = eventSelect ? eventSelect.value : '';
    
    if (!selectedEvent) {
        listContainer.innerHTML = '<p>Please select an event first.</p>';
        isPopulatingContactList = false;
        return;
    }
    
    // ... rest of your existing regular contacts code
    
    try {
        const snapshot = await db.collection('contacts').orderBy('timestamp', 'desc').get();
        
        // Clear loading message and add control buttons at the top
        listContainer.innerHTML = '';
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
        listContainer.innerHTML = '<p style="color: red;">Error loading contacts.</p>';
    } finally {
        isPopulatingContactList = false;
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

function selectNotInvited() {
    const checkboxes = document.querySelectorAll('#dynamic-contact-list input[type="checkbox"]');
    checkboxes.forEach(cb => {
        const contactDiv = cb.closest('.contact-entry');
        if (contactDiv && contactDiv.getAttribute('data-status') === 'not_invited') {
            cb.checked = true;
        }
    });
}

async function loadRSVPs() {
    const groupsDiv = document.getElementById('rsvp-groups');
    groupsDiv.innerHTML = '';
    
    // Load events from database to get their collection names
    let eventCollections = [];
    
    try {
        const eventsSnapshot = await db.collection('events').get();
        if (!eventsSnapshot.empty) {
            eventCollections = eventsSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    name: data.name,
                    collectionName: data.collectionName
                };
            });
        }
    } catch (error) {
        console.error('Error loading events for RSVPs:', error);
    }

    // Load contacts for name lookup
    const contactsMap = new Map();
    try {
        const contactsSnapshot = await db.collection('contacts').get();
        
        contactsSnapshot.forEach(doc => {
            const data = doc.data();
            const normalizedPhone = normalizePhone(data.phone);
            if (data.phone) {
                contactsMap.set(data.phone, data.name);
                if (normalizedPhone && normalizedPhone !== data.phone) {
                    contactsMap.set(normalizedPhone, data.name);
                }
            }
        });
    } catch (error) {
        console.error('Error loading contacts for name lookup:', error);
    }

    for (const event of eventCollections) {
        const groupDiv = document.createElement('div');
        groupDiv.innerHTML = `<h3>${event.name} RSVPs</h3>
            <button onclick="deleteAllForEvent('${event.collectionName}')">Delete All for This Event</button>
            <table id="rsvp-table-${event.collectionName}">
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
            const snapshot = await db.collection(event.collectionName).orderBy('timestamp', 'desc').get();
            
            snapshot.forEach(doc => {
                const data = doc.data();
                
                let displayName = data.name;
                const shouldLookup = (
                    data.name === 'Unknown' || 
                    data.name === 'Unknown (SMS)' || 
                    !data.name || 
                    data.name.trim() === '' ||
                    data.name.toLowerCase().includes('unknown')
                );
                
                if (shouldLookup && data.phone) {
                    if (contactsMap.has(data.phone)) {
                        displayName = contactsMap.get(data.phone);
                    } else {
                        const normalizedRSVPPhone = normalizePhone(data.phone);
                        if (normalizedRSVPPhone && contactsMap.has(normalizedRSVPPhone)) {
                            displayName = contactsMap.get(normalizedRSVPPhone);
                        }
                    }
                }
                
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${displayName || 'Unknown'}</td>
                    <td>${data.phone || ''}</td>
                    <td>${data.attending}</td>
                    <td>${data.guests}</td>
                    <td>${data.notes || ''}</td>
                    <td>${data.timestamp ? data.timestamp.toDate().toLocaleString() : ''}</td>
                    <td><button onclick="deleteRSVP('${doc.id}', '${event.collectionName}')">Delete</button></td>
                `;
                tableBody.appendChild(row);
            });
        } catch (error) {
            console.error(`Error loading RSVPs for ${event.collectionName}:`, error);
        }
    }
}

async function deleteRSVP(id, collectionName) {
    if (confirm('Delete this RSVP?')) {
        try {
            await db.collection(collectionName).doc(id).delete();
            loadRSVPs();
            populateDynamicContactList();
        } catch (error) {
            console.error('Error deleting RSVP:', error);
        }
    }
}

async function deleteAllForEvent(collectionName) {
    if (confirm(`Delete all RSVPs for this event?`)) {
        try {
            const snapshot = await db.collection(collectionName).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            loadRSVPs();
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

// Handle admin password submission
async function handleAdminPasswordSubmit() {
    const passwordInput = document.getElementById('admin-password-input');
    const errorEl = document.getElementById('admin-password-error');
    const submitButton = document.querySelector('#admin-password-prompt button');
    
    if (!passwordInput || !passwordInput.value) {
        errorEl.textContent = 'Please enter the admin password.';
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Verifying...';
    errorEl.textContent = '';

    try {
        const isValid = await window.auth.login(passwordInput.value, 'admin');
        
        if (isValid) {
            document.getElementById('admin-password-prompt').style.display = 'none';
            document.getElementById('admin-content').style.display = 'block';
            initializeAdmin();
        } else {
            errorEl.textContent = 'Incorrect admin password. Access denied.';
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (error) {
        console.error('Admin authentication error:', error);
        errorEl.textContent = 'Authentication failed. Please try again.';
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Check if already authenticated as admin
    if (window.auth && window.auth.hasRole('admin')) {
        document.getElementById('admin-password-prompt').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        initializeAdmin();
    } else {
        document.getElementById('admin-password-prompt').style.display = 'block';
        
        // Add enter key support for admin password
        const adminPasswordInput = document.getElementById('admin-password-input');
        if (adminPasswordInput) {
            adminPasswordInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    handleAdminPasswordSubmit();  // CHANGED: was checkAdminPassword()
                }
            });
            adminPasswordInput.focus();
        }
    }

    // Admin password form handler
    const adminPasswordForm = document.getElementById('admin-password-form');
    if (adminPasswordForm) {
        adminPasswordForm.addEventListener('submit', (e) => {
            e.preventDefault();
            handleAdminPasswordSubmit();  // CHANGED: was checkAdminPassword()
        });
    }

    // Event form submission handler
const eventForm = document.getElementById('event-form');
if (eventForm) {
    eventForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitButton = e.target.querySelector('button[type="submit"]');
        const originalText = submitButton.textContent;
        
        submitButton.disabled = true;
        submitButton.textContent = 'Saving...';
        
        const eventName = document.getElementById('event-name').value;
        const eventData = {
            name: eventName,
            date: document.getElementById('event-date').value,
            description: document.getElementById('event-description').value,
            menu: document.getElementById('event-menu').value.split('\n').filter(item => item.trim()),
            whatToBring: document.getElementById('event-bring').value,
            schedule: document.getElementById('event-schedule').value.split('\n').filter(item => item.trim()),
            collectionName: createCollectionName(eventName),
            isActive: document.getElementById('event-active').checked
        };
        
        const editId = eventForm.getAttribute('data-edit-id');
        const success = await saveEvent(eventData, editId);
        
        const messageEl = document.getElementById('event-message');
        if (success) {
            messageEl.textContent = editId ? 'Event updated successfully!' : 'Event created successfully!';
            messageEl.style.color = 'green';
            clearEventForm();
            loadEvents();
            loadEventOptions();
        } else {
            messageEl.textContent = 'Error saving event. Please try again.';
            messageEl.style.color = 'red';
        }
        
        submitButton.disabled = false;
        submitButton.textContent = originalText;
    });
}  // closes the if (eventForm) block
});    // closes the DOMContentLoaded event listener