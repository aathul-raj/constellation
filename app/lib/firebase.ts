import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';

let firebaseApp: App | null = null;
let firestoreDb: Firestore | null = null;

// Lazy initialization - only runs when actually needed (at runtime)
function initializeFirebaseIfNeeded() {
  // Skip initialization during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  if (!getApps().length && !firebaseApp) {
    firebaseApp = initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Replace literal \n with actual newlines
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.split('\\n').join('\n'),
      }),
    });
  }
}

// Getter function for db that initializes on first use
export function getDb(): Firestore {
  if (!firestoreDb) {
    initializeFirebaseIfNeeded();
    firestoreDb = getFirestore();
  }
  return firestoreDb;
}

export const db = new Proxy({} as Firestore, {
  get(target, prop) {
    return getDb()[prop as keyof Firestore];
  }
});

// Collections
export const collections = {
  users: 'users',
  projects: 'projects',
} as const;