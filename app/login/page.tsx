'use client';

import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useRef, useMemo } from 'react';
import styles from './landing.module.css';

// Starfield with constellation connections
function StarField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let stars: Array<{
      x: number;
      y: number;
      size: number;
      brightness: number;
      twinkleSpeed: number;
      twinkleOffset: number;
      isConstellation: boolean;
    }> = [];

    let constellationStars: Array<{
      x: number;
      y: number;
      size: number;
      brightness: number;
    }> = [];

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      initStars();
    };

    const initStars = () => {
      stars = [];
      constellationStars = [];
      const width = canvas.offsetWidth;
      const height = canvas.offsetHeight;

      // Background stars
      const starCount = Math.floor((width * height) / 3000);
      for (let i = 0; i < starCount; i++) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: Math.random() * 1.5 + 0.5,
          brightness: Math.random() * 0.5 + 0.3,
          twinkleSpeed: Math.random() * 0.02 + 0.01,
          twinkleOffset: Math.random() * Math.PI * 2,
          isConstellation: false
        });
      }

      // Constellation clusters positioned away from center text
      const clusters = [
        { x: width * 0.12, y: height * 0.2, count: 5 },   // Top left
        { x: width * 0.88, y: height * 0.15, count: 4 },  // Top right
        { x: width * 0.08, y: height * 0.7, count: 4 },   // Bottom left
        { x: width * 0.92, y: height * 0.65, count: 5 },  // Bottom right
        { x: width * 0.2, y: height * 0.45, count: 3 },   // Mid left
        { x: width * 0.82, y: height * 0.4, count: 3 },   // Mid right
      ];

      clusters.forEach(cluster => {
        const spread = 60 + Math.random() * 40;
        for (let i = 0; i < cluster.count; i++) {
          const angle = (i / cluster.count) * Math.PI * 2 + Math.random() * 0.8;
          const dist = spread * (0.3 + Math.random() * 0.7);
          constellationStars.push({
            x: cluster.x + Math.cos(angle) * dist,
            y: cluster.y + Math.sin(angle) * dist,
            size: 1.5 + Math.random() * 1.5,
            brightness: 0.7 + Math.random() * 0.3
          });
        }
      });
    };

    let time = 0;
    const animate = () => {
      time += 0.016;
      ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);

      // Draw background stars with twinkling
      stars.forEach(star => {
        const twinkle = Math.sin(time * star.twinkleSpeed * 60 + star.twinkleOffset) * 0.3 + 0.7;
        const alpha = star.brightness * twinkle;

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(228, 228, 231, ${alpha})`;
        ctx.fill();
      });

      // Draw constellation connections
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.15)';
      ctx.lineWidth = 1;

      for (let i = 0; i < constellationStars.length; i++) {
        const star = constellationStars[i];
        // Connect to nearby stars
        for (let j = i + 1; j < constellationStars.length; j++) {
          const other = constellationStars[j];
          const dx = star.x - other.x;
          const dy = star.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 200) {
            ctx.beginPath();
            ctx.moveTo(star.x, star.y);
            ctx.lineTo(other.x, other.y);
            ctx.globalAlpha = 0.3 * (1 - dist / 200);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

      // Draw constellation stars with glow
      constellationStars.forEach(star => {
        const pulse = Math.sin(time * 2) * 0.1 + 0.9;

        // Outer glow
        const gradient = ctx.createRadialGradient(
          star.x, star.y, 0,
          star.x, star.y, star.size * 8
        );
        gradient.addColorStop(0, `rgba(59, 130, 246, ${0.3 * pulse})`);
        gradient.addColorStop(0.5, `rgba(99, 102, 241, ${0.1 * pulse})`);
        gradient.addColorStop(1, 'transparent');

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size * 8, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Star core
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(228, 228, 231, ${star.brightness})`;
        ctx.fill();
      });

      animationId = requestAnimationFrame(animate);
    };

    resize();
    animate();

    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.starfield} />;
}

// Animated constellation logo
function ConstellationLogo({ size = 28 }: { size?: number }) {
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
        stroke="currentColor" strokeWidth="0.5" opacity="0.4" className={styles.logoLines} />
    </svg>
  );
}

// Pipeline flow visualization
function PipelineFlow() {
  const [activeNode, setActiveNode] = useState(0);
  const nodes = [
    { label: 'Data Source', type: 'input' },
    { label: 'Transform', type: 'compute' },
    { label: 'Analyze', type: 'compute' },
    { label: 'Output', type: 'output' }
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveNode(prev => (prev + 1) % (nodes.length + 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [nodes.length]);

  return (
    <div className={styles.pipelineFlow}>
      {nodes.map((node, idx) => (
        <div key={idx} className={styles.pipelineNode}>
          <div
            className={`${styles.nodeCircle} ${styles[node.type]} ${idx <= activeNode ? styles.nodeActive : ''}`}
          >
            <div className={styles.nodeInner} />
          </div>
          <span className={styles.nodeLabel}>{node.label}</span>
          {idx < nodes.length - 1 && (
            <div className={`${styles.nodeEdge} ${idx < activeNode ? styles.edgeActive : ''}`}>
              <div className={styles.edgeParticle} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Feature card
function FeatureCard({ icon, title, description }: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className={styles.featureCard}>
      <div className={styles.featureIcon}>{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

// Code demo with transformation
function CodeDemo() {
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setShowCode(prev => !prev);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={styles.codeDemo}>
      <div className={`${styles.codeWindow} ${!showCode ? styles.windowActive : ''}`}>
        <div className={styles.windowHeader}>
          <div className={styles.windowDots}>
            <span /><span /><span />
          </div>
          <span className={styles.windowTitle}>Your Request</span>
        </div>
        <div className={styles.windowBody}>
          <p className={styles.naturalText}>
            "Analyze my sales data - filter for Q4 2024, group by region, calculate total revenue, and find the top 5 performing stores"
          </p>
        </div>
      </div>

      <div className={styles.transformIcon}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </div>

      <div className={`${styles.codeWindow} ${showCode ? styles.windowActive : ''}`}>
        <div className={styles.windowHeader}>
          <div className={styles.windowDots}>
            <span /><span /><span />
          </div>
          <span className={styles.windowTitle}>Generated Pipeline</span>
        </div>
        <div className={styles.windowBody}>
          <pre className={styles.codeText}>{`def task(sales_df):
    # Distributed across cluster
    filtered = sales_df[
        sales_df['quarter'] == 'Q4'
    ]

    result = (filtered
        .groupby('region')
        .agg({'revenue': 'sum'})
        .nlargest(5, 'revenue'))

    return result`}</pre>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [isVisible, setIsVisible] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    if (session) {
      router.push('/');
    }
  }, [session, router]);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 400);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (status === 'loading') {
    return (
      <div className={styles.loading}>
        <div className={styles.loadingSpinner} />
      </div>
    );
  }

  return (
    <div className={styles.landing}>
      <StarField />

      {/* Navigation */}
      <nav className={`${styles.nav} ${showBackToTop ? styles.navScrolled : ''}`}>
        <div className={styles.navLeft}>
          {showBackToTop && (
            <button className={styles.backBtn} onClick={scrollToTop} aria-label="Back to top">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className={styles.logo}>
            <ConstellationLogo />
            <span>Constellation</span>
          </div>
        </div>
        <button className={styles.signInBtn} onClick={() => signIn('google', { callbackUrl: '/' })}>
          Sign In
        </button>
      </nav>

      {/* Hero */}
      <section className={`${styles.hero} ${isVisible ? styles.heroVisible : ''}`}>
        <div className={styles.heroContent}>
          <div className={styles.heroBadge}>
            <span className={styles.badgeStar}>✦</span>
            High-Performance Computing
          </div>

          <h1 className={styles.heroTitle}>
            Turn Words into
            <span className={styles.gradient}> Parallel Workflows</span>
          </h1>

          <p className={styles.heroDescription}>
            Describe your data processing in plain English. Constellation transforms your ideas into
            optimized parallel pipelines that run on distributed compute clusters — no coding required.
          </p>

          <div className={styles.heroCtas}>
            <button className={styles.primaryBtn} onClick={() => signIn('google', { callbackUrl: '/' })}>
              <span>Get Started Free</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
            <a href="#features" className={styles.secondaryBtn}>
              Learn More
            </a>
          </div>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statNumber}>10x</span>
              <span className={styles.statLabel}>Faster Processing</span>
            </div>
            <div className={styles.statDivider} />
            <div className={styles.stat}>
              <span className={styles.statNumber}>Zero</span>
              <span className={styles.statLabel}>Code Required</span>
            </div>
            <div className={styles.statDivider} />
            <div className={styles.stat}>
              <span className={styles.statNumber}>Cloud</span>
              <span className={styles.statLabel}>Scale Instantly</span>
            </div>
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section className={styles.useCases}>
        <p className={styles.useCasesLabel}>Empowering researchers and analysts in</p>
        <div className={styles.useCasesList}>
          <span>Genomics</span>
          <span>Climate Science</span>
          <span>Finance</span>
          <span>Bioinformatics</span>
          <span>Machine Learning</span>
        </div>
      </section>

      {/* How It Works */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionBadge}>✦ How It Works</span>
          <h2>From Idea to Execution</h2>
          <p>Three simple steps to process your data at scale</p>
        </div>

        <PipelineFlow />

        <div className={styles.stepsGrid}>
          <div className={styles.step}>
            <div className={styles.stepNum}>01</div>
            <h3>Describe Your Task</h3>
            <p>Tell our AI what you want to do with your data using natural language. No technical jargon needed.</p>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNum}>02</div>
            <h3>AI Builds Pipeline</h3>
            <p>Constellation generates an optimized parallel workflow, automatically handling data distribution.</p>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNum}>03</div>
            <h3>Deploy & Monitor</h3>
            <p>One click sends your pipeline to the cloud. Watch progress in real-time as results stream in.</p>
          </div>
        </div>
      </section>

      {/* Demo Section */}
      <section className={styles.demoSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionBadge}>✦ See It In Action</span>
          <h2>Natural Language to Code</h2>
          <p>Watch your words transform into production-ready parallel processing</p>
        </div>
        <CodeDemo />
      </section>

      {/* Features */}
      <section id="features" className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionBadge}>✦ Features</span>
          <h2>Built for Scale</h2>
          <p>Enterprise-grade infrastructure, zero complexity</p>
        </div>

        <div className={styles.featuresGrid}>
          <FeatureCard
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.4V12h3a3 3 0 0 1 3 3v1a2 2 0 0 1-2 2h-1v1a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3v-1H6a2 2 0 0 1-2-2v-1a3 3 0 0 1 3-3h3V9.4c-1.2-.6-2-1.9-2-3.4a4 4 0 0 1 4-4z"/></svg>}
            title="AI-Powered"
            description="Describe tasks naturally. Our AI understands context and generates optimized parallel code automatically."
          />
          <FeatureCard
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>}
            title="Auto-Parallelization"
            description="Workflows are automatically distributed across cores and nodes for maximum performance."
          />
          <FeatureCard
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>}
            title="Cloud Native"
            description="Deploy to AWS with one click. Scale from laptop testing to thousands of cores seamlessly."
          />
          <FeatureCard
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-3.3-6.7-2.8 2.8m-5.8 5.8-2.8 2.8m0-11.3 2.8 2.8m5.8 5.8 2.8 2.8"/></svg>}
            title="Visual Builder"
            description="Drag-and-drop interface to design complex workflows. Connect nodes and visualize data flow."
          />
          <FeatureCard
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18 9l-5 5-4-4-3 3"/></svg>}
            title="Real-Time Monitoring"
            description="Watch jobs execute live. Debug console, progress tracking, and detailed execution logs."
          />
          <FeatureCard
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>}
            title="Secure & Private"
            description="Your data stays in your cloud account. Enterprise-grade security and full compliance."
          />
        </div>
      </section>

      {/* CTA */}
      <section className={styles.ctaSection}>
        <div className={styles.ctaGlow} />
        <div className={styles.ctaContent}>
          <h2>Ready to accelerate your research?</h2>
          <p>Join researchers processing data faster than ever before.</p>
          <button className={styles.ctaBtn} onClick={() => signIn('google', { callbackUrl: '/' })}>
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerContent}>
          <div className={styles.footerLogo}>
            <ConstellationLogo size={20} />
            <span>Constellation</span>
          </div>
          <p>Making high-performance computing accessible to everyone.</p>
        </div>
      </footer>

      {/* Back to Top */}
      <button
        className={`${styles.backToTop} ${showBackToTop ? styles.backToTopVisible : ''}`}
        onClick={scrollToTop}
        aria-label="Back to top"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
    </div>
  );
}
