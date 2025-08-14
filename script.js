document.getElementById('rsvp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value;
    const attending = document.getElementById('attending').value;
    const guests = document.getElementById('guests').value;
    const bringing = document.getElementById('bringing').value;
    const notes = document.getElementById('notes').value;
    const messageEl = document.getElementById('form-message');
    const eventName = 'dinner-party'; // Change this for each event (e.g., match your event title)

    try {
        await db.collection(`rsvps-${eventName}`).add({
            name,
            attending,
            guests: parseInt(guests),
            bringing,
            notes,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        messageEl.textContent = 'RSVP submitted! Thank you!';
        messageEl.style.color = 'green';
        document.getElementById('rsvp-form').reset();
    } catch (error) {
        messageEl.textContent = 'Error submitting RSVP. Try again.';
        messageEl.style.color = 'red';
    }
});