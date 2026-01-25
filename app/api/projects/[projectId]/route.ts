import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { db, collections } from '@/app/lib/firebase';
import { HPCGraph } from '@/app/store/hpc-store';

// GET - Get a specific project
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await params;
    const docRef = db.collection(collections.projects).doc(projectId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const data = doc.data();

    // Verify ownership
    if (data?.userEmail !== session.user.email) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({
      id: doc.id,
      ...data,
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 });
  }
}

// PUT - Update a project
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await params;
    const docRef = db.collection(collections.projects).doc(projectId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const data = doc.data();

    // Verify ownership
    if (data?.userEmail !== session.user.email) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { name, graph, chatMessages } = body as { name?: string; graph?: HPCGraph; chatMessages?: any[] };

    const updateData: any = {
      updatedAt: Date.now(),
    };

    if (name !== undefined) updateData.name = name;
    if (graph !== undefined) updateData.graph = graph;
    if (chatMessages !== undefined) updateData.chatMessages = chatMessages;

    await docRef.update(updateData);

    return NextResponse.json({
      id: doc.id,
      ...data,
      ...updateData,
    });
  } catch (error) {
    console.error('Error updating project:', error);
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
  }
}

// DELETE - Delete a project
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await params;
    const docRef = db.collection(collections.projects).doc(projectId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const data = doc.data();

    // Verify ownership
    if (data?.userEmail !== session.user.email) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await docRef.delete();

    return NextResponse.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
  }
}
