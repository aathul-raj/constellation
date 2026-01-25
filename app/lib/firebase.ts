import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin (server-side only)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Replace literal \n with actual newlines
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.split('\\n').join('\n'),
    }),
  });
}

export const db = getFirestore();

// Collections
export const collections = {
  users: 'users',
  projects: 'projects',
} as const;
