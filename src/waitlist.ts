import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  getDocs, 
  doc, 
  getDoc, 
  setDoc,
  query, 
  orderBy, 
  onSnapshot,
  Timestamp,
  updateDoc
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Auth configurations
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/spreadsheets');
googleProvider.addScope('https://www.googleapis.com/auth/drive.file');

// Cache our state
let activeUser: User | null = null;
let googleAccessToken: string | null = null;
let activeSpreadsheetId: string | null = null;
let subscribersList: any[] = [];
let unsubscribeListener: (() => void) | null = null;

// Error helper enum & interface conforming to Firestore integration instructions
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: any, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  
  console.error('Firestore Operation Failed:', JSON.stringify(errInfo));
  
  // If it's an offline error, display a subtle warning instead of crashing
  if (errInfo.error.includes('offline') || errInfo.error.includes('unavailable')) {
    console.warn('Firestore is running in offline/cached capability mode.');
  }
}

// Get sheet config from Firestore
async function fetchSheetConfig(): Promise<string | null> {
  const path = 'config/sheets';
  const cachedId = localStorage.getItem('truce_spreadsheet_id');
  try {
    const configDoc = await getDoc(doc(db, 'config', 'sheets'));
    if (configDoc.exists()) {
      const spreadsheetId = configDoc.data().spreadsheetId || null;
      if (spreadsheetId) {
        localStorage.setItem('truce_spreadsheet_id', spreadsheetId);
        return spreadsheetId;
      }
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const isOffline = errMsg.includes('offline') || errMsg.includes('unavailable');
    if (isOffline) {
      console.warn('Firestore is running in offline capability mode. Restoring Google Sheet ID from browser cache:', cachedId);
      return cachedId;
    }
    handleFirestoreError(err, OperationType.GET, path);
  }
  return cachedId;
}

// Save sheet config to Firestore
async function saveSheetConfig(id: string) {
  const path = 'config/sheets';
  // Mirror to LocalStorage immediately for instant persistent recovery
  localStorage.setItem('truce_spreadsheet_id', id);
  activeSpreadsheetId = id;
  renderStatus();

  try {
    await setDoc(doc(db, 'config', 'sheets'), {
      spreadsheetId: id,
      updatedAt: Timestamp.now()
    }, { merge: true });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const isOffline = errMsg.includes('offline') || errMsg.includes('unavailable');
    if (isOffline) {
      console.warn('Firestore is currently offline. Config backed up locally and will auto-propagate to cloud database when back online.');
    } else {
      handleFirestoreError(err, OperationType.WRITE, path);
      alert('Failed to save Spreadsheet ID to Firestore config.');
    }
  }
}

// Check if user is already logged in
onAuthStateChanged(auth, async (user) => {
  activeUser = user;
  
  if (unsubscribeListener) {
    unsubscribeListener();
    unsubscribeListener = null;
  }
  
  if (user) {
    console.log('Admin user authenticated:', user.email);
    // If the admin signed in, retrieve spreadsheet configuration
    activeSpreadsheetId = await fetchSheetConfig();
    
    // Listen for waitlist updates real-time
    listenToSubscribers();
  } else {
    console.log('No active authenticated session.');
    activeSpreadsheetId = null;
    subscribersList = [];
    renderStatus();
  }
});

// Sign-in function
async function signInAdmin() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      googleAccessToken = credential.accessToken;
      console.log('Successfully authorized with Google Sheets scopes.');
      
      // Auto trigger a quick sync of any pending items
      setTimeout(() => syncPendingSubscribers(), 1000);
    }
    renderStatus();
  } catch (err: any) {
    console.error('Auth failure:', err);
    alert(`Authentication failed: ${err.message}`);
  }
}

// Sign-out function
async function signOutAdmin() {
  await signOut(auth);
  googleAccessToken = null;
  renderStatus();
}

// Save subscriber to Firestore waitlist
async function registerSubscriber(email: string) {
  try {
    const newDoc = await addDoc(collection(db, 'waitlist'), {
      email: email,
      createdAt: Timestamp.now(),
      status: 'pending' // pending or synced
    });
    
    // If the admin is authenticated and we have a Sheet ID, sync in real-time
    if (googleAccessToken && activeSpreadsheetId) {
      syncSingleSubscriber(newDoc.id, email);
    }
  } catch (err) {
    console.error('Failed to register subscriber in memory:', err);
  }
}

// Create a new spreadsheet automatically
async function createNewSpreadsheet() {
  if (!googleAccessToken) {
    alert('Please sign in with Google first.');
    return;
  }
  const createBtn = document.getElementById('btn-create-sheet') as HTMLButtonElement | null;
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.textContent = 'Creating Spreadsheet...';
  }
  
  try {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${googleAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          title: 'Truce App - Waitlist Subscriber Log'
        },
        sheets: [
          {
            properties: {
              title: 'Subscriber List',
              gridProperties: {
                rowCount: 1000,
                columnCount: 3
              }
            }
          }
        ]
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google API error: ${errText}`);
    }
    
    const spreadsheet = await response.json();
    const sheetId = spreadsheet.spreadsheetId;
    
    // Write headers on Column A, B, C
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/'Subscriber List'!A1:C1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${googleAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        range: "'Subscriber List'!A1:C1",
        majorDimension: 'ROWS',
        values: [
          ['Waitlist Email Address', 'Date Joined', 'Timestamp']
        ]
      })
    });
    
    // Save new ID to config
    await saveSheetConfig(sheetId);
    alert('Success! A new designated Google Spreadsheet has been automatically created in your Google Drive and linked!');
  } catch (err: any) {
    console.error('Failed to create sheet:', err);
    alert(`Could not create sheet: ${err.message}`);
  } finally {
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = '🪄 Create New Spreadsheet';
    }
  }
}

// Sync single subscriber
async function syncSingleSubscriber(docId: string, email: string) {
  if (!googleAccessToken || !activeSpreadsheetId) return;
  
  try {
    const formattedDate = new Date().toLocaleString();
    const timestamp = Date.now().toString();
    
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${activeSpreadsheetId}/values/'Subscriber List'!A:C:append?valueInputOption=USER_ENTERED`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${googleAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        range: "'Subscriber List'!A:C",
        majorDimension: 'ROWS',
        values: [
          [email, formattedDate, timestamp]
        ]
      })
    });
    
    if (response.ok) {
      // Update status in Firestore
      await updateDoc(doc(db, 'waitlist', docId), {
        status: 'synced',
        syncedAt: Timestamp.now()
      });
      console.log(`Synced subscriber ${email} successfully to sheet.`);
    } else {
      console.warn('Sheet append failed:', await response.text());
    }
  } catch (e) {
    console.error('Error in single sync:', e);
  }
}

// Sync all pending subscribers
async function syncPendingSubscribers() {
  if (!googleAccessToken) {
    alert('Please sign in with Google first.');
    return;
  }
  if (!activeSpreadsheetId) {
    alert('Please connect or create a Google Spreadsheet ID first.');
    return;
  }
  
  const syncBtn = document.getElementById('btn-sync-all') as HTMLButtonElement | null;
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = '⚡ Syncing logs...';
  }
  
  const pendingItems = subscribersList.filter(item => item.status === 'pending');
  let syncCount = 0;
  
  for (const item of pendingItems) {
    try {
      const formattedDate = item.createdAt ? new Date(item.createdAt.seconds * 1000).toLocaleString() : new Date().toLocaleString();
      const timestamp = item.createdAt ? (item.createdAt.seconds * 1000).toString() : Date.now().toString();
      
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${activeSpreadsheetId}/values/'Subscriber List'!A:C:append?valueInputOption=USER_ENTERED`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          range: "'Subscriber List'!A:C",
          majorDimension: 'ROWS',
          values: [
            [item.email, formattedDate, timestamp]
          ]
        })
      });
      
      if (response.ok) {
        await updateDoc(doc(db, 'waitlist', item.id), {
          status: 'synced',
          syncedAt: Timestamp.now()
        });
        syncCount++;
      } else {
        console.error('Append failed for:', item.email, await response.text());
      }
    } catch (err) {
      console.error('Failed to sync item:', item.email, err);
    }
  }
  
  if (syncBtn) {
    syncBtn.disabled = false;
    syncBtn.innerHTML = '🔄 Sync Pending Emails';
  }
  
  if (syncCount > 0) {
    alert(`Success! Synced ${syncCount} pending subscribers to your Google Sheet.`);
  } else {
    alert('All emails are already synced and up to date!');
  }
}

// Live Firestore updates
function listenToSubscribers() {
  const path = 'waitlist';
  try {
    const q = query(collection(db, 'waitlist'), orderBy('createdAt', 'desc'));
    unsubscribeListener = onSnapshot(q, (snapshot) => {
      subscribersList = [];
      snapshot.forEach((d) => {
        subscribersList.push({
          id: d.id,
          ...d.data()
        });
      });
      renderStatus();
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, path);
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

// Populate status indicator & views
function renderStatus() {
  const container = document.getElementById('admin-status-container');
  if (!container) return;
  
  const pendingCount = subscribersList.filter(s => s.status === 'pending').length;
  const syncedCount = subscribersList.filter(s => s.status === 'synced').length;
  
  let html = `
    <div style="font-family: var(--font-sans); color: var(--body-text); padding: 10px 0;">
      <!-- Row 1: Connection status -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--primary-border); padding-bottom: 12px;">
        <div>
          <h4 style="font-weight: 800; font-size: 15px; margin-bottom: 3px;">Google Sheets & Firestore waitlist portal</h4>
          <p style="font-size: 11.5px; color: var(--muted-text);">Store waitlist emails locally in Firestore and sync with Google Sheets.</p>
        </div>
        <div style="display: flex; gap: 8px;">
          ${activeUser ? `
            <button id="admin-signout-btn" style="background: none; border: 1px solid var(--muted-text); color: var(--body-text); font-size: 11px; padding: 4px 10px; border-radius: 8px; cursor: pointer; font-family: var(--font-mono);">
              Sign Out [${activeUser.email?.slice(0, 8)}...]
            </button>
          ` : `
            <button id="admin-signin-btn" class="gsi-material-button" style="transform: scale(0.85); transform-origin: right;">
              <div class="gsi-material-button-state"></div>
              <div class="gsi-material-button-content-wrapper">
                <div class="gsi-material-button-icon">
                  <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style="display: block;">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                  </svg>
                </div>
                <span class="gsi-material-button-contents">Sign in with Google</span>
              </div>
            </button>
          `}
        </div>
      </div>

      <!-- Live statistics cards -->
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 20px;">
        <div style="background: var(--surface-color); border: 1px solid var(--primary-border); padding: 12px; border-radius: 12px; text-align: center;">
          <div style="font-size: 11px; color: var(--muted-text); font-weight: 600; text-transform: uppercase;">Total Registrations</div>
          <div style="font-size: 26px; font-weight: 800; color: var(--body-text); margin-top: 4px;">${subscribersList.length}</div>
        </div>
        <div style="background: var(--surface-color); border: 1px solid rgba(5, 202, 151, 0.15); padding: 12px; border-radius: 12px; text-align: center;">
          <div style="font-size: 11px; color: #05ca97; font-weight: 600; text-transform: uppercase;">Synced to Sheets</div>
          <div style="font-size: 26px; font-weight: 800; color: #05ca97; margin-top: 4px;">${syncedCount}</div>
        </div>
        <div style="background: var(--surface-color); border: 1px solid rgba(255, 159, 28, 0.15); padding: 12px; border-radius: 12px; text-align: center;">
          <div style="font-size: 11px; color: #ff9f1c; font-weight: 600; text-transform: uppercase;">Pending Sync</div>
          <div style="font-size: 26px; font-weight: 800; color: #ff9f1c; margin-top: 4px;">${pendingCount}</div>
        </div>
      </div>

      <!-- Config & Action panel -->
      <div style="background: rgba(255, 65, 93, 0.02); border: 1px dashed var(--primary-border); border-radius: 14px; padding: 16px; margin-bottom: 20px;">
        <h5 style="font-weight: 700; font-size: 13px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">⚙️ Google Spreadsheet Binding</h5>
        
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <input type="text" id="sheets-id-input" placeholder="Google Spreadsheet ID" value="${activeSpreadsheetId || ''}" 
                   style="flex: 1; min-width: 200px; padding: 10px 14px; font-size: 12.5px; border-radius: 10px; border: 1px solid var(--primary-border); font-family: var(--font-mono); background: var(--surface-color); outline: none;">
            <button id="btn-save-sheet-id" style="background: var(--body-text); color: white; padding: 10px 16px; border-radius: 10px; font-size: 12px; font-weight: 600; border: none; cursor: pointer;">
              Save Sheet ID
            </button>
          </div>
          
          <div style="display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
            ${googleAccessToken ? `
              <button id="btn-create-sheet" style="background: var(--surface-color); border: 1px solid var(--primary-border); color: var(--primary-accent); padding: 9px 14px; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                🪄 Create New Spreadsheet
              </button>
            ` : `
              <span style="font-size: 11.5px; color: var(--muted-text); font-style: italic;">👉 Authorize with Google Sheets to unlock full auto-create & sync features.</span>
            `}
            
            ${activeSpreadsheetId ? `
              <a href="https://docs.google.com/spreadsheets/d/${activeSpreadsheetId}" target="_blank" style="color: var(--primary-accent); font-size: 12px; text-decoration: underline; font-weight: 600;">
                🟢 Open Linked Sheet ↗
              </a>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- Logs database -->
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <h5 style="font-weight: 700; font-size: 13px;">📋 Waitlist Database Logs</h5>
          ${pendingCount > 0 ? `
            <button id="btn-sync-all" style="background: var(--primary-accent); color: white; border: none; padding: 6px 12px; border-radius: 8px; font-size: 11.5px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 10px var(--primary-glow);">
              🔄 Sync Pending Emails
            </button>
          ` : `
            <span style="font-size: 11.5px; color: #05ca97; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">✓ Up To Date</span>
          `}
        </div>

        <div style="max-height: 180px; overflow-y: auto; background: var(--surface-color); border: 1px solid var(--primary-border); border-radius: 10px;">
          ${subscribersList.length === 0 ? `
            <div style="padding: 24px; text-align: center; color: var(--muted-text); font-size: 12px; font-style: italic;">
              No waitlist subscribers registered yet. Try submitting an email address on the main page!
            </div>
          ` : `
            <table style="width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left;">
              <thead>
                <tr style="background: var(--bg-color); border-bottom: 1px solid var(--primary-border);">
                  <th style="padding: 8px 12px; font-weight: 700;">Email</th>
                  <th style="padding: 8px 12px; font-weight: 700;">Signup Date</th>
                  <th style="padding: 8px 12px; font-weight: 700;">Sync Status</th>
                </tr>
              </thead>
              <tbody>
                ${subscribersList.map(item => {
                  const dateStr = item.createdAt ? new Date(item.createdAt.seconds * 1000).toLocaleDateString() : 'Just Now';
                  const isSynced = item.status === 'synced';
                  return `
                    <tr style="border-bottom: 1px solid rgba(255, 65, 93, 0.05);">
                      <td style="padding: 8px 12px; font-family: var(--font-mono); font-weight: 500;">${item.email}</td>
                      <td style="padding: 8px 12px; color: var(--muted-text);">${dateStr}</td>
                      <td style="padding: 8px 12px;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; 
                                     background: ${isSynced ? 'rgba(5, 202, 151, 0.08)' : 'rgba(255, 159, 28, 0.08)'}; 
                                     color: ${isSynced ? '#05ca97' : '#ff9f1c'};">
                          ${isSynced ? 'Synced' : 'Pending'}
                        </span>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>
    </div>
  `;
  
  container.innerHTML = html;
  
  // Bind dynamic actions
  const signInBtn = document.getElementById('admin-signin-btn');
  if (signInBtn) signInBtn.onclick = signInAdmin;
  
  const signOutBtn = document.getElementById('admin-signout-btn');
  if (signOutBtn) signOutBtn.onclick = signOutAdmin;
  
  const createSheetBtn = document.getElementById('btn-create-sheet');
  if (createSheetBtn) createSheetBtn.onclick = createNewSpreadsheet;
  
  const syncBtn = document.getElementById('btn-sync-all');
  if (syncBtn) syncBtn.onclick = syncPendingSubscribers;
  
  const saveBtn = document.getElementById('btn-save-sheet-id');
  if (saveBtn) {
    saveBtn.onclick = () => {
      const input = document.getElementById('sheets-id-input') as HTMLInputElement | null;
      if (input && input.value.trim()) {
        saveSheetConfig(input.value.trim());
        alert('Sheets ID linked successfully!');
      } else {
        alert('Please fill out a valid Spreadsheet ID first.');
      }
    };
  }
}

// Intercept form submissions on the main landing page!
function hookLandingPageForms() {
  const waitlistForm = document.getElementById('waitlist-form-el') as HTMLFormElement | null;
  const heroWaitlistForm = document.querySelector('.hero-waitlist-form') as HTMLFormElement | null;
  
  if (waitlistForm) {
    waitlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById('waitlist-email') as HTMLInputElement | null;
      const successBox = document.getElementById('waitlist-success') as HTMLElement | null;
      if (emailInput && emailInput.value.trim()) {
        const email = emailInput.value.trim();
        
        // Visual indicator
        const submitBtn = waitlistForm.querySelector('button');
        if (submitBtn) {
          submitBtn.textContent = 'Joining...';
          submitBtn.disabled = true;
          submitBtn.style.transform = 'scale(0.95)';
        }
        
        // Save to Firestore and sync
        await registerSubscriber(email);
        
        setTimeout(() => {
          waitlistForm.style.display = 'none';
          if (successBox) successBox.style.display = 'block';
        }, 600);
      }
    });
  }

  if (heroWaitlistForm) {
    heroWaitlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById('hero-waitlist-email') as HTMLInputElement | null;
      const heroBtn = document.getElementById('hero-waitlist-btn-id') as HTMLButtonElement | null;
      if (emailInput && heroBtn && emailInput.value.trim()) {
        const email = emailInput.value.trim();
        
        // Visual indicator
        heroBtn.textContent = 'Joining...';
        heroBtn.disabled = true;
        
        // Save to Firestore and sync
        await registerSubscriber(email);
        
        setTimeout(() => {
          heroBtn.textContent = 'Awesome! 🎉';
          heroBtn.style.backgroundColor = 'var(--secondary-accent)';
          emailInput.value = '';
          
          // Also trigger the primary bottom waitlist form success block gracefully
          const bottomInput = document.getElementById('waitlist-email') as HTMLInputElement | null;
          if (bottomInput) bottomInput.value = email;
          const bottomForm = document.getElementById('waitlist-form-el') as HTMLElement | null;
          const successBox = document.getElementById('waitlist-success') as HTMLElement | null;
          if (bottomForm && successBox) {
            bottomForm.style.display = 'none';
            successBox.style.display = 'block';
            
            const waitlistSection = document.getElementById('waitlist');
            if (waitlistSection) {
              waitlistSection.scrollIntoView({ behavior: 'smooth' });
            }
          }
          
          setTimeout(() => {
            heroBtn.textContent = 'Join Waitlist';
            heroBtn.disabled = false;
            heroBtn.style.backgroundColor = 'var(--primary-accent)';
          }, 4000);
        }, 750);
      }
    });
  }
}

// Hook waitlist forms on page load
window.addEventListener('DOMContentLoaded', () => {
  hookLandingPageForms();
  renderStatus();
});
