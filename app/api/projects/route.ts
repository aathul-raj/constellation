import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { db, collections } from '@/app/lib/firebase';
import { HPCGraph } from '@/app/store/hpc-store';

// GET - List all projects for the current user
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectsRef = db.collection(collections.projects);
    const snapshot = await projectsRef
      .where('userEmail', '==', session.user.email)
      .get();

    const projects = snapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
      }))
      // Sort in-memory to avoid needing a Firestore composite index
      .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return NextResponse.json({ projects });
  } catch (error) {
    console.error('Error fetching projects:', error);
    return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 });
  }
}

// POST - Create a new project
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { name, graph } = body as { name: string; graph: HPCGraph };

    if (!name || !graph) {
      return NextResponse.json({ error: 'Name and graph are required' }, { status: 400 });
    }

    const projectData = {
      name,
      graph,
      userEmail: session.user.email,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const docRef = await db.collection(collections.projects).add(projectData);

    return NextResponse.json({
      id: docRef.id,
      ...projectData,
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating project:', error);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
