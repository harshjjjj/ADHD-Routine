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
const db = (firebaseConfig as any).firestoreDatabaseId 
  ? getFirestore(app, (firebaseConfig as any).firestoreDatabaseId)
  : getFirestore(app);

// Auth configurations
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/spreadsheets');
googleProvider.addScope('https://www.googleapis.com/auth/drive.file');

// Cache our state
let activeUser: User | null = null;
let googleAccessToken: string | null = null;
let activeSpreadsheetId: string | null = null;
let activeEmailConfig: any = null;
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

// Fetch welcome auto-reply email configuration
async function fetchEmailConfig() {
  const path = 'config/email';
  try {
    const configDoc = await getDoc(doc(db, 'config', 'email'));
    if (configDoc.exists()) {
      return configDoc.data();
    }
  } catch (err: any) {
    console.error('Failed to load email config from Firestore:', err);
  }
  // fallback default template values if not created yet
  return {
    enabled: false,
    serviceId: '',
    templateId: '',
    publicKey: '',
    senderName: 'Truce Team',
    replyTo: 'hello@truceapp.site',
    emailSubject: 'Welcome to Truce! 🌅',
    emailBody: 'Hi there,\n\nThank you for your interest in Truce! We are excited to have you on our waitlist. We will reach out as soon as we make more spots available!\n\nBest,\nThe Truce Team'
  };
}

// Save email config to Firestore
async function saveEmailConfig(config: any) {
  const path = 'config/email';
  activeEmailConfig = config;
  renderStatus();

  try {
    await setDoc(doc(db, 'config', 'email'), {
      ...config,
      updatedAt: Timestamp.now()
    }, { merge: true });
  } catch (err: any) {
    console.error('Failed to save email config to Firestore:', err);
    alert('Failed to save email settings to Firestore config.');
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
    // If the admin signed in, retrieve spreadsheet and email configurations
    activeSpreadsheetId = await fetchSheetConfig();
    activeEmailConfig = await fetchEmailConfig();
    
    // Listen for waitlist updates real-time
    listenToSubscribers();
  } else {
    console.log('No active authenticated session.');
    activeSpreadsheetId = null;
    activeEmailConfig = null;
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

      <!-- Auto-Reply Email Config Panel (Only renders for authenticated administrators) -->
      ${activeUser ? `
        <div style="background: rgba(66, 133, 244, 0.02); border: 1px dashed var(--primary-border); border-radius: 14px; padding: 16px; margin-bottom: 20px;">
          <h5 style="font-weight: 700; font-size: 13px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">📧 Auto-Reply Email Setup (via EmailJS)</h5>
          <p style="font-size: 11.5px; color: var(--muted-text); margin-bottom: 14px;">Automatically send a welcome thank-you email immediately when someone joins the waitlist.</p>
          
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <!-- Status Toggle Row -->
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="checkbox" id="email-enabled-toggle" ${activeEmailConfig?.enabled ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px; accent-color: var(--primary-accent);">
              <label for="email-enabled-toggle" style="font-size: 12.5px; font-weight: 700; cursor: pointer; color: var(--body-text);">Enable Auto-Reply Email</label>
            </div>

            <!-- Configuration Helper Tip -->
            <div style="background: rgba(66, 133, 244, 0.05); padding: 10px 14px; border-radius: 10px; font-size: 11px; color: var(--body-text); border: 1px solid rgba(66, 133, 244, 0.12); font-family: var(--font-sans); line-height: 1.4;">
              🌅 <strong>EmailJS Setup:</strong> Create a free account at <a href="https://www.emailjs.com/" target="_blank" style="color: var(--primary-accent); text-decoration: underline; font-weight: 600;">emailjs.com</a>, link an email service provider, and create an Email Template. Use template keys <code>{{email_subject}}</code>, <code>{{message}}</code>, and <code>{{to_email}}</code> to map content.
            </div>

            <!-- EmailJS Service Credentials Grid -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
              <div>
                <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">EmailJS Service ID</label>
                <input type="text" id="email-service-id" placeholder="e.g. service_gxx8sae" value="${activeEmailConfig?.serviceId || ''}" 
                       style="width: 100%; padding: 8px 12px; font-size: 12px; border-radius: 8px; border: 1px solid var(--primary-border); font-family: var(--font-mono); background: var(--surface-color); outline: none; color: var(--body-text);">
              </div>
              <div>
                <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">EmailJS Template ID</label>
                <input type="text" id="email-template-id" placeholder="e.g. template_p93b8sh" value="${activeEmailConfig?.templateId || ''}" 
                       style="width: 100%; padding: 8px 12px; font-size: 12px; border-radius: 8px; border: 1px solid var(--primary-border); font-family: var(--font-mono); background: var(--surface-color); outline: none; color: var(--body-text);">
              </div>
            </div>
            <div>
              <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">EmailJS Public Key</label>
              <input type="text" id="email-public-key" placeholder="e.g. kH3g4XnsY8_xxxxxx" value="${activeEmailConfig?.publicKey || ''}" 
                     style="width: 100%; padding: 8px 12px; font-size: 12px; border-radius: 8px; border: 1px solid var(--primary-border); font-family: var(--font-mono); background: var(--surface-color); outline: none; color: var(--body-text);">
            </div>

            <!-- Sender configuration Row -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
              <div>
                <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">Sender Header Name</label>
                <input type="text" id="email-sender-name" placeholder="e.g. Truce Team" value="${activeEmailConfig?.senderName || 'Truce Team'}" 
                       style="width: 100%; padding: 8px 12px; font-size: 12.5px; border-radius: 8px; border: 1px solid var(--primary-border); background: var(--surface-color); outline: none; color: var(--body-text);">
              </div>
              <div>
                <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">Reply-To Address</label>
                <input type="text" id="email-reply-to" placeholder="e.g. contact@truceapp.site" value="${activeEmailConfig?.replyTo || 'hello@truceapp.site'}" 
                       style="width: 100%; padding: 8px 12px; font-size: 12.5px; border-radius: 8px; border: 1px solid var(--primary-border); background: var(--surface-color); outline: none; color: var(--body-text);">
              </div>
            </div>

            <!-- Template customizer subject/body -->
            <div>
              <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">Email Subject Line</label>
              <input type="text" id="email-subject" placeholder="Welcome to Truce! 🌅" value="${activeEmailConfig?.emailSubject || 'Welcome to Truce! 🌅'}" 
                     style="width: 100%; padding: 8px 12px; font-size: 12.5px; border-radius: 8px; border: 1px solid var(--primary-border); background: var(--surface-color); outline: none; color: var(--body-text); margin-bottom: 8px;">
              
              <label style="font-size: 10px; color: var(--muted-text); text-transform: uppercase; font-weight: 700; display: block; margin-bottom: 3.5px;">Thank-You Message Body</label>
              <textarea id="email-body" rows="4" placeholder="Customize the thank-you note content..." 
                        style="width: 100%; padding: 10px 12px; font-size: 12px; border-radius: 8px; border: 1px solid var(--primary-border); background: var(--surface-color); outline: none; color: var(--body-text); font-family: var(--font-sans); line-height: 1.45; resize: vertical;">${activeEmailConfig?.emailBody || 'Hi there,\n\nThank you for your interest in Truce! We are excited to have you on our waitlist. We will reach out as soon as we make more spots available!\n\nBest regards,\nThe Truce Team'}</textarea>
            </div>

            <!-- Save settings action -->
            <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
              <button id="btn-save-email-settings" style="background: var(--body-text); color: white; padding: 10px 18px; border-radius: 10px; font-size: 12px; font-weight: 700; border: none; cursor: pointer;">
                Save Email Configurations
              </button>
            </div>
          </div>
        </div>
      ` : ''}

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

        <div style="max-height: 240px; overflow-y: auto; background: var(--surface-color); border: 1px solid var(--primary-border); border-radius: 10px;">
          ${subscribersList.length === 0 ? `
            <div style="padding: 24px; text-align: center; color: var(--muted-text); font-size: 12px; font-style: italic;">
              No waitlist subscribers registered yet. Try submitting an email address on the main page!
            </div>
          ` : `
            <table style="width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left;">
              <thead>
                <tr style="background: var(--bg-color); border-bottom: 1px solid var(--primary-border);">
                  <th style="padding: 10px 12px; font-weight: 700;">Email / Feedback</th>
                  <th style="padding: 10px 12px; font-weight: 700;">Signup Date</th>
                  <th style="padding: 10px 12px; font-weight: 700;">Sync Status</th>
                  <th style="padding: 10px 12px; font-weight: 700;">Auto-Reply Status</th>
                </tr>
              </thead>
              <tbody>
                ${subscribersList.map(item => {
                  const dateStr = item.createdAt ? new Date(item.createdAt.seconds * 1000).toLocaleDateString() : 'Just Now';
                  const isSynced = item.status === 'synced';
                  
                  // Draft auto-reply welcome email delivery badge based on status fields
                  const mailStatus = item.emailStatus || 'none';
                  let mailBadge = '';
                  if (mailStatus === 'sent') {
                    mailBadge = `<span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; background: rgba(5, 202, 151, 0.08); color: #05ca97;">🟢 Sent</span>`;
                  } else if (mailStatus === 'failed') {
                    mailBadge = `<span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; background: rgba(255, 65, 93, 0.08); color: #ff415d; cursor: help;" title="${item.emailError || 'Email validation or API configuration key mismatch.'}">🔴 Failed</span>`;
                  } else if (mailStatus === 'sending') {
                    mailBadge = `<span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; background: rgba(66, 133, 244, 0.08); color: #4285f4Animation;">⏳ Sending...</span>`;
                  } else {
                    mailBadge = `<span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; background: rgba(140, 140, 140, 0.08); color: #888;">⚪ Off/None</span>`;
                  }

                  return `
                    <tr style="border-bottom: 1px solid rgba(255, 65, 93, 0.05);">
                      <td style="padding: 10px 12px; font-family: var(--font-mono); font-weight: 500;">
                        <div style="font-weight: 700; color: var(--body-text);">${item.email}</div>
                        ${item.feedback ? `
                          <div style="margin-top: 4px; padding: 4px 8px; font-family: var(--font-sans); font-size: 10.5px; background: rgba(255, 65, 93, 0.03); border-left: 2px solid var(--primary-accent); border-radius: 4px; width: fit-content; max-width: 320px; word-break: break-all; white-space: normal; color: var(--body-text);">
                            💬 "${item.feedback}"
                          </div>
                        ` : ''}
                      </td>
                      <td style="padding: 10px 12px; color: var(--muted-text);">${dateStr}</td>
                      <td style="padding: 10px 12px;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; 
                                     background: ${isSynced ? 'rgba(5, 202, 151, 0.08)' : 'rgba(255, 159, 28, 0.08)'}; 
                                     color: ${isSynced ? '#05ca97' : '#ff9f1c'};">
                          ${isSynced ? 'Synced' : 'Pending'}
                        </span>
                      </td>
                      <td style="padding: 10px 12px;">
                        ${mailBadge}
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

  // Save Email Configurations click listener
  const saveEmailSettingsBtn = document.getElementById('btn-save-email-settings');
  if (saveEmailSettingsBtn) {
    saveEmailSettingsBtn.onclick = async () => {
      const enabledToggle = document.getElementById('email-enabled-toggle') as HTMLInputElement | null;
      const serviceIdInput = document.getElementById('email-service-id') as HTMLInputElement | null;
      const templateIdInput = document.getElementById('email-template-id') as HTMLInputElement | null;
      const publicKeyInput = document.getElementById('email-public-key') as HTMLInputElement | null;
      const senderNameInput = document.getElementById('email-sender-name') as HTMLInputElement | null;
      const replyToInput = document.getElementById('email-reply-to') as HTMLInputElement | null;
      const subjectInput = document.getElementById('email-subject') as HTMLInputElement | null;
      const bodyTextarea = document.getElementById('email-body') as HTMLTextAreaElement | null;

      const newConfig = {
        enabled: enabledToggle ? enabledToggle.checked : false,
        serviceId: serviceIdInput ? serviceIdInput.value.trim() : '',
        templateId: templateIdInput ? templateIdInput.value.trim() : '',
        publicKey: publicKeyInput ? publicKeyInput.value.trim() : '',
        senderName: senderNameInput ? senderNameInput.value.trim() : 'Truce Team',
        replyTo: replyToInput ? replyToInput.value.trim() : 'hello@truceapp.site',
        emailSubject: subjectInput ? subjectInput.value.trim() : 'Welcome to Truce! 🌅',
        emailBody: bodyTextarea ? bodyTextarea.value : ''
      };

      saveEmailSettingsBtn.textContent = 'Saving configs...';
      (saveEmailSettingsBtn as HTMLButtonElement).disabled = true;

      try {
        await saveEmailConfig(newConfig);
        alert('Email Auto-Reply configurations saved in Firestore successfully!');
      } catch (e: any) {
        alert('Failed to save email settings: ' + (e.message || e));
      } finally {
        saveEmailSettingsBtn.textContent = 'Save Email Configurations';
        (saveEmailSettingsBtn as HTMLButtonElement).disabled = false;
      }
    };
  }
}

// Hook waitlist forms on page load
window.addEventListener('DOMContentLoaded', () => {
  renderStatus();
  
  // Double-verify admin button visibility in the workspace package
  if (window.location.href.toLowerCase().includes('admin=true')) {
    const adminBtn = document.getElementById('btn-admin-portal-open');
    if (adminBtn) {
      adminBtn.style.display = 'flex';
    }
  }
});
