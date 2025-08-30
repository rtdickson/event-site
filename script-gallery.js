// Firebase config is loaded from firebase-config.js
// Initialize storage here since gallery needs it
const storage = firebase.storage();

document.addEventListener('DOMContentLoaded', () => {
    // Use new auth system instead of sessionStorage
    if (!window.auth || !window.auth.requireAuth('guest')) {
        return; // Auth will handle redirect
    }
    
    loadGallery();
});

async function uploadPhoto() {
    const file = document.getElementById('photo-input').files[0];
    if (!file) {
        alert('Please select a photo to upload.');
        return;
    }
    
    const messageEl = document.getElementById('upload-message');
    const uploadButton = document.querySelector('button[onclick="uploadPhoto()"]');
    const originalText = uploadButton.textContent;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        messageEl.textContent = 'Please select a valid image file.';
        messageEl.style.color = 'red';
        return;
    }
    
    // Validate file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
        messageEl.textContent = 'File too large. Please select an image under 10MB.';
        messageEl.style.color = 'red';
        return;
    }
    
    // Show loading state
    uploadButton.disabled = true;
    uploadButton.textContent = 'Uploading...';
    messageEl.textContent = 'Uploading photo...';
    messageEl.style.color = '#666';
    
    const storageRef = storage.ref(`gallery/${Date.now()}_${file.name}`);
    
    try {
        const uploadTask = storageRef.put(file);
        
        // Monitor upload progress
        uploadTask.on('state_changed', 
            (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                messageEl.textContent = `Upload progress: ${Math.round(progress)}%`;
            },
            (error) => {
                console.error('Upload error:', error);
                messageEl.textContent = 'Error uploading photo. Please try again.';
                messageEl.style.color = 'red';
            },
            () => {
                messageEl.textContent = 'Photo uploaded successfully!';
                messageEl.style.color = 'green';
                document.getElementById('photo-input').value = '';
                loadGallery(); // Refresh gallery
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        messageEl.textContent = 'Error uploading photo. Please try again.';
        messageEl.style.color = 'red';
    } finally {
        // Reset button state
        uploadButton.disabled = false;
        uploadButton.textContent = originalText;
    }
}

async function loadGallery() {
    const galleryGrid = document.getElementById('gallery-grid');
    galleryGrid.innerHTML = '<p>Loading photos...</p>';
    
    const listRef = storage.ref('gallery');
    
    try {
        const res = await listRef.listAll();
        
        if (res.items.length === 0) {
            galleryGrid.innerHTML = '<p>No photos uploaded yet. Be the first to share your memories!</p>';
            return;
        }
        
        galleryGrid.innerHTML = '';
        
        // Load photos in parallel but limit concurrent requests
        const batchSize = 6;
        for (let i = 0; i < res.items.length; i += batchSize) {
            const batch = res.items.slice(i, i + batchSize);
            const promises = batch.map(async (itemRef) => {
                try {
                    const url = await itemRef.getDownloadURL();
                    return { itemRef, url };
                } catch (error) {
                    console.error('Error getting download URL:', error);
                    return null;
                }
            });
            
            const results = await Promise.all(promises);
            
            results.forEach(result => {
                if (result) {
                    const { itemRef, url } = result;
                    
                    const imageContainer = document.createElement('div');
                    imageContainer.className = 'gallery-item';
                    imageContainer.style.position = 'relative';
                    
                    const link = document.createElement('a');
                    link.href = url;
                    link.target = '_blank';
                    link.title = 'Click to view full size';
                    
                    const img = document.createElement('img');
                    img.src = url;
                    img.alt = 'Event Photo';
                    img.loading = 'lazy'; // Lazy load images
                    img.style.maxWidth = '100%';
                    img.style.height = 'auto';
                    
                    // Add error handling for images
                    img.onerror = function() {
                        this.alt = 'Failed to load image';
                        this.style.backgroundColor = '#f0f0f0';
                        this.style.color = '#666';
                    };
                    
                    link.appendChild(img);
                    imageContainer.appendChild(link);
                    galleryGrid.appendChild(imageContainer);
                }
            });
        }
        
    } catch (error) {
        console.error('Error loading gallery:', error);
        galleryGrid.innerHTML = '<p style="color: red;">Error loading photos. Please refresh the page.</p>';
    }
}