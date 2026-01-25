'use client';

import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from './landing.module.css';

// --- Animated Logo Component ---
function ConstellationLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={styles.constellationLogo}>
      {/* Stars */}
      <circle cx="12" cy="4" r="1.5" fill="currentColor" className={styles.logoStar} />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" className={styles.logoStar} style={{ animationDelay: '0.2s' }} />
      <circle cx="20" cy="12" r="1.5" fill="currentColor" className={styles.logoStar} style={{ animationDelay: '0.4s' }} />
      <circle cx="8" cy="20" r="1.5" fill="currentColor" className={styles.logoStar} style={{ animationDelay: '0.6s' }} />
      <circle cx="16" cy="20" r="1.5" fill="currentColor" className={styles.logoStar} style={{ animationDelay: '0.8s' }} />
      <circle cx="12" cy="12" r="2" fill="currentColor" className={styles.logoCenterStar} />
      {/* Connections */}
      <path d="M12 4L4 12M12 4L20 12M12 4L12 12M4 12L12 12M20 12L12 12M4 12L8 20M20 12L16 20M12 12L8 20M12 12L16 20M8 20L16 20"
        stroke="currentColor" strokeWidth="1" className={styles.logoLines} />
    </svg>
  );
}

// --- Helper Components ---

function PipelineStep({ number, title, desc }: { number: string, title: string, desc: string }) {
  return (
    <div style={{ padding: '2rem', borderLeft: '1px solid rgba(59, 130, 246, 0.2)' }}>
      <div style={{ fontFamily: 'JetBrains Mono', color: '#60a5fa', marginBottom: '0.5rem', fontSize: '0.8rem' }}>
        {number}
      </div>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem', color: '#f8fafc' }}>{title}</h3>
      <p style={{ fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.6 }}>{desc}</p>
    </div>
  );
}

function CodeDemo() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setActive(prev => !prev), 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={styles.demoContainer}>
      {/* Input */}
      <div className={`${styles.codeWindow} ${!active ? styles.active : ''}`}>
        <div className={styles.windowHeader}>
          <span className={styles.windowTitle}>INPUT // NATURAL LANGUAGE</span>
        </div>
        <div className={styles.windowContent}>
          <p className={styles.promptText}>
            "Pull Q4 2025 sales data, group by region, and calculate total revenue. Filter out returns and visualize."
          </p>
        </div>
      </div>

      <div className={styles.transformIcon}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </div>

      {/* Output */}
      <div className={`${styles.codeWindow} ${active ? styles.active : ''}`}>
        <div className={styles.windowHeader}>
          <span className={styles.windowTitle}>OUTPUT // OPTIMIZED PIPELINE</span>
        </div>
        <div className={styles.windowContent}>
          <div className={styles.pythonText}>
            <span className={styles.pythonKeyword}>def</span> <span className={styles.pythonFunc}>process_revenue</span>(df):<br/>
            &nbsp;&nbsp;q4 = df.<span className={styles.pythonFunc}>filter</span>(q=<span className={styles.pythonString}>'Q4'</span>, year=2025)<br/>
            &nbsp;&nbsp;valid = q4.<span className={styles.pythonFunc}>exclude</span>(type=<span className={styles.pythonString}>'return'</span>)<br/>
            &nbsp;&nbsp;<span className={styles.pythonKeyword}>return</span> valid.<span className={styles.pythonFunc}>groupby</span>(<span className={styles.pythonString}>'region'</span>).<span className={styles.pythonFunc}>sum</span>()
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (session) router.push('/');
  }, [session, router]);

  if (status === 'loading') {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
      </div>
    );
  }

  return (
    <div className={styles.landing}>
      
      {/* Navigation */}
      <nav className={styles.nav}>
        <div className={styles.logoContainer}>
          <ConstellationLogo />
          <span>Constellation</span>
        </div>
        <button 
          className={styles.signInBtn}
          onClick={() => signIn('google', { callbackUrl: '/' })}
        >
          Sign In
        </button>
      </nav>

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.badge}>
          <div className={styles.badgeDot} />
          V1.0 BETA
        </div>
        <h1 className={styles.heroTitle}>
          Compute without <br />
          <span className={styles.gradientText}>Infrastructure.</span>
        </h1>
        <p className={styles.heroDesc}>
          Turn natural language into high-performance parallel pipelines.
          We handle the serialization, sharding, and cluster management.
        </p>
        <div className={styles.heroCtas}>
          <button className={styles.primaryBtn} onClick={() => signIn('google')}>
            Start Computing
          </button>
          <a href="#demo" className={styles.secondaryBtn}>
            Read the Docs
          </a>
        </div>
      </section>

      {/* Demo Section */}
      <section id="demo" className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>01 — TRANSLATION ENGINE</span>
          <h2>Structured execution.</h2>
        </div>
        <CodeDemo />
      </section>

      {/* Workflow */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>02 — WORKFLOW</span>
          <h2>How it works.</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '12px', background: 'rgba(255,255,255,0.02)' }}>
          <PipelineStep 
            number="01" 
            title="Declare Intent" 
            desc="Describe your data transformation in plain English or simplified Python definitions." 
          />
          <PipelineStep 
            number="02" 
            title="Graph Compilation" 
            desc="Our engine builds a Directed Acyclic Graph (DAG) optimized for parallel execution." 
          />
          <PipelineStep 
            number="03" 
            title="Distributed Compute" 
            desc="Tasks are dispatched to ephemeral microVMs for instant processing at scale." 
          />
        </div>
      </section>

      {/* Features Grid */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>03 — CAPABILITIES</span>
          <h2>System specifications.</h2>
        </div>
        
        <div className={styles.bentoGrid}>
          {/* Feature 1: Autopilot */}
          <div className={styles.bentoCard}>
            <div className={styles.bentoIcon}>
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                 <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
               </svg>
            </div>
            <h3>Autopilot</h3>
            <p>Self-healing nodes automatically detect runtime errors, generate code fixes, and redeploy instantly.</p>
          </div>

          {/* Feature 2: Auto-Sharding */}
          <div className={styles.bentoCard}>
            <div className={styles.bentoIcon}>
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                 <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                 <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                 <line x1="12" y1="22.08" x2="12" y2="12" />
               </svg>
            </div>
            <h3>Auto-Sharding</h3>
            <p>Datasets are automatically partitioned and distributed across available compute nodes for maximum throughput.</p>
          </div>

           {/* Feature 3: Live Telemetry */}
          <div className={styles.bentoCard}>
            <div className={styles.bentoIcon}>
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                 <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                 <line x1="8" y1="21" x2="16" y2="21" />
                 <line x1="12" y1="17" x2="12" y2="21" />
               </svg>
            </div>
            <h3>Basic Telemetry</h3>
            <p>Real-time visibility into your pipeline status. Track which nodes are queued, executing, failed, or succeeded.</p>
          </div>

          {/* Feature 4: AI Analysis */}
          <div className={styles.bentoCard}>
            <div className={styles.bentoIcon}>
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                 <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
               </svg>
            </div>
            <h3>Output Analysis</h3>
            <p>AI-driven insights are generated automatically on your pipeline's final output for instant summarization.</p>
          </div>

          {/* Feature 5: Integrated Linting */}
          <div className={styles.bentoCard}>
            <div className={styles.bentoIcon}>
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                 <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                 <path d="m9 12 2 2 4-4" />
               </svg>
            </div>
            <h3>Integrated Linting</h3>
            <p>Built-in static analysis catches syntax errors and potential logic flaws in your nodes before deployment.</p>
          </div>

          {/* Feature 6: Zero Config */}
          <div className={styles.bentoCard}>
            <div className={styles.bentoIcon}>
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                 <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
               </svg>
            </div>
            <h3>Zero Config</h3>
            <p>No Kubernetes, no Dockerfiles, no YAML hell. Just write code and push to execute.</p>
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerLogo}>
          <ConstellationLogo size={20} />
          <span>Constellation</span>
        </div>
        <p className={styles.footerCredits}>
          Built by Athul, Cameron, Josh, and Justus for TAMUHack 26'.
        </p>
      </footer>
    </div>
  );
}