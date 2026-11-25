/**
 * Master Application Client Logic (AuraPay Platform & Dashboard)
 */

document.addEventListener('DOMContentLoaded', () => {
  // App State
  let currentMerchant = null;
  let activeOnboardingStep = 1;
  let uploadedQrPath = '/uploads/default-qr.jpeg';
  let decodedUpiId = '8789601387@fam';
  let authToken = '';
  let registrationOpen = false;
  try { authToken = localStorage.getItem('aurapay_token') || ''; } catch (e) {}

  // Every dashboard request goes through here so the sign-in token is always attached
  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401 && authToken) {
      signOut('Your session ended. Please sign in again.');
      throw new Error('unauthenticated');
    }
    return res;
  }

  // Views
  const views = {
    landing: document.getElementById('viewLanding'),
    auth: document.getElementById('viewAuth'),
    onboarding: document.getElementById('viewOnboarding')
  };

  // Nav Elements
  const brandLogo = document.getElementById('brandLogo');
  const btnNavLogin = document.getElementById('btnNavLogin');
  const btnNavRegister = document.getElementById('btnNavRegister');
  const navWatcherStatus = document.getElementById('navWatcherStatus');
  const navWatcherText = document.getElementById('navWatcherText');
  const btnHeroGetStarted = document.getElementById('btnHeroGetStarted');
  const btnHeroDemoCheckout = document.getElementById('btnHeroDemoCheckout');

  // Auth Elements
  const authTitle = document.getElementById('authTitle');
  const authSubtitle = document.getElementById('authSubtitle');
  const tabSignIn = document.getElementById('tabSignIn');
  const tabSignUp = document.getElementById('tabSignUp');
  const formSignIn = document.getElementById('formSignIn');
  const formSignUp = document.getElementById('formSignUp');
  const loginEmail = document.getElementById('loginEmail');
  const loginPass = document.getElementById('loginPass');

  // Onboarding Elements
  const obBusinessName = document.getElementById('obBusinessName');
  const obUpiId = document.getElementById('obUpiId');
  const qrDropzone = document.getElementById('qrDropzone');
  const qrFileInput = document.getElementById('qrFileInput');
  const btnSelectQrFile = document.getElementById('btnSelectQrFile');
  const qrDetectionPreview = document.getElementById('qrDetectionPreview');
  const previewQrImg = document.getElementById('previewQrImg');
  const detectedUpiTag = document.getElementById('detectedUpiTag');
  const obGmailUser = document.getElementById('obGmailUser');
  const obGmailPass = document.getElementById('obGmailPass');
  const btnTestGmailImap = document.getElementById('btnTestGmailImap');
  const testBtnText = document.getElementById('testBtnText');
  const testBtnSpinner = document.getElementById('testBtnSpinner');
  const testFeedback = document.getElementById('testFeedback');
  const obApiKeyDisplay = document.getElementById('obApiKeyDisplay');
  const btnCopyObApiKey = document.getElementById('btnCopyObApiKey');
  const btnGoToDashboard = document.getElementById('btnGoToDashboard');

  const toastContainer = document.getElementById('toastContainer');

  init();

  function init() {
    setupNavigation();
    setupAuth();
    setupOnboarding();
    loadSavedSession();
  }

  // ==============================================================
  // 1. NAVIGATION & ROUTING
  // ==============================================================
  function showView(viewId) {
    Object.values(views).forEach(v => {
      if (v) v.classList.remove('active');
    });
    if (views[viewId]) {
      views[viewId].classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // The merchant dashboard is its own page (/dashboard) and handles sign-in itself
  function goDashboard(section) {
    window.location.href = `/dashboard${section ? `#${section}` : ''}`;
  }

  function setupNavigation() {
    brandLogo.addEventListener('click', () => showView('landing'));

    btnNavLogin.addEventListener('click', () => goDashboard());

    // Sign-up only exists when the server allows new merchant accounts
    const startOrOpen = () => {
      if (currentMerchant || !registrationOpen) return goDashboard();
      setAuthTab('signup');
      showView('auth');
    };
    btnNavRegister.addEventListener('click', startOrOpen);
    btnHeroGetStarted.addEventListener('click', startOrOpen);

    // Open Test Paywall
    btnHeroDemoCheckout.addEventListener('click', () => {
      window.open('/test/new', '_blank');
    });

    // The status pill opens the Verification page of the dashboard
    const openImap = () => goDashboard('verification');
    navWatcherStatus.addEventListener('click', openImap);
    navWatcherStatus.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openImap(); }
    });

    // Interactive Hero Simulation
    const btnTriggerHeroSimulation = document.getElementById('btnTriggerHeroSimulation');
    if (btnTriggerHeroSimulation) {
      btnTriggerHeroSimulation.addEventListener('click', () => {
        triggerHeroSimulation();
      });
    }
  }

  function triggerHeroSimulation() {
    const radarTitle = document.getElementById('heroRadarTitle');
    const radarSub = document.getElementById('heroRadarSub');
    const phoneNotif = document.getElementById('heroPhoneNotif');
    const radarBox = document.getElementById('heroRadarBox');

    showToast('Simulating customer scanning and paying ₹500...');
    radarTitle.textContent = 'Incoming payment alert detected...';
    radarSub.textContent = 'Parsing bank IMAP stream...';

    setTimeout(() => {
      if (phoneNotif) {
        phoneNotif.style.transform = 'translateY(0) scale(1.04)';
        phoneNotif.style.borderColor = '#10B981';
      }
      if (radarTitle) radarTitle.textContent = '✓ Payment Verified in 1.2s';
      if (radarSub) radarSub.textContent = 'Order #PAY-892104 settled directly into your FamPay account.';
      if (radarBox) {
        radarBox.style.background = '#ECFDF5';
        radarBox.style.borderColor = '#A7F3D0';
      }

      if (typeof confetti === 'function') {
        confetti({ particleCount: 75, spread: 65, origin: { y: 0.65 } });
      }

      showToast('Payment verified successfully!');
    }, 1100);

    setTimeout(() => {
      if (phoneNotif) {
        phoneNotif.style.transform = 'none';
        phoneNotif.style.borderColor = '';
      }
    }, 4500);
  }

  // ==============================================================
  // 2. AUTHENTICATION LOGIC
  // ==============================================================
  function setupAuth() {
    tabSignIn.addEventListener('click', () => setAuthTab('signin'));
    tabSignUp.addEventListener('click', () => setAuthTab('signup'));

    // Sign In Submit
    formSignIn.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = loginEmail.value.trim();
      const password = loginPass.value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (data.success && data.merchant && data.token) {
          loginPass.value = '';
          handleAuthSuccess(data.merchant, data.token);
        } else {
          showToast(data.error || 'Invalid credentials');
        }
      } catch (err) {
        showToast('Login request failed');
      }
    });

    // Sign Up Submit
    formSignUp.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('regName').value.trim();
      const businessName = document.getElementById('regBusiness').value.trim();
      const email = document.getElementById('regEmail').value.trim();
      const password = document.getElementById('regPass').value;

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, businessName, email, password })
        });
        const data = await res.json();

        if (data.success && data.merchant) {
          showToast('Account created successfully!');
          handleAuthSuccess(data.merchant, data.token);
        } else {
          showToast(data.error || 'Registration failed');
        }
      } catch (err) {
        showToast('Network error during registration');
      }
    });
  }

  function setAuthTab(tab) {
    if (tab === 'signup' && !registrationOpen) tab = 'signin';
    if (tab === 'signin') {
      tabSignIn.classList.add('active');
      tabSignUp.classList.remove('active');
      formSignIn.classList.remove('hidden');
      formSignUp.classList.add('hidden');
      authTitle.textContent = 'Sign In to AuraPay';
      authSubtitle.textContent = 'Manage your payment gateway, API keys, and live transactions.';
    } else {
      tabSignUp.classList.add('active');
      tabSignIn.classList.remove('active');
      formSignUp.classList.remove('hidden');
      formSignIn.classList.add('hidden');
      authTitle.textContent = 'Create Merchant Account';
      authSubtitle.textContent = 'Start accepting zero-fee direct UPI payments in minutes.';
    }
  }

  function handleAuthSuccess(merchant, token) {
    currentMerchant = merchant;
    if (token) {
      authToken = token;
      try { localStorage.setItem('aurapay_token', token); } catch (e) {}
    }
    updateNavState();

    if (!merchant.isOnboarded) {
      showView('onboarding');
      window.nextOnboardingSlide(1);
    } else {
      goDashboard();
    }
  }

  async function loadSavedSession() {
    // Older versions kept the whole merchant record (including secrets) in the browser
    try { localStorage.removeItem('aurapay_merchant'); } catch (e) {}

    try {
      const cfg = await (await fetch('/api/auth/config')).json();
      registrationOpen = Boolean(cfg.registrationOpen);
      tabSignUp.classList.toggle('hidden', !registrationOpen);
      const hint = document.getElementById('authSetupHint');
      if (hint) hint.classList.toggle('hidden', cfg.signInReady !== false);
    } catch (e) {}
    updateNavState();

    if (!authToken) return;
    try {
      const res = await api('/api/auth/me');
      const data = await res.json();
      if (data.success && data.merchant) {
        currentMerchant = data.merchant;
        updateNavState();
        const imap = await (await api('/api/merchant/imap')).json();
        if (imap.success) updateNavWatcher(imap.status);
      }
    } catch (e) {}
  }

  function signOut(message) {
    authToken = '';
    currentMerchant = null;
    try { localStorage.removeItem('aurapay_token'); } catch (e) {}
    updateNavState();
    updateNavWatcher(null);
    if (message) {
      setAuthTab('signin');
      showView('auth');
      showToast(message);
    } else {
      showView('landing');
    }
  }

  function updateNavState() {
    if (currentMerchant) {
      btnNavLogin.textContent = currentMerchant.businessName || 'Dashboard';
      btnNavRegister.textContent = 'Open Dashboard';
    } else {
      btnNavLogin.textContent = 'Sign In';
      btnNavRegister.textContent = registrationOpen ? 'Get Started Free' : 'Merchant Sign In';
    }
  }

  // The pill in the top bar shows the real state of the Gmail connection
  function describeWatcher(status) {
    if (!status) return { tone: 'is-off', label: 'Sign in to view', title: 'Not signed in', sub: '' };
    switch (status.state) {
      case 'connected':
        return { tone: '', label: 'Active', title: 'Connected and listening', sub: `Watching ${status.user} for bank credit alerts.` };
      case 'connecting':
        return { tone: 'is-warn', label: 'Connecting…', title: 'Connecting to Gmail…', sub: `Signing in to ${status.user}.` };
      case 'reconnecting':
        return { tone: 'is-warn', label: 'Reconnecting…', title: 'Connection lost, reconnecting', sub: (status.lastError && status.lastError.message) || '' };
      case 'auth_failed':
        return { tone: 'is-error', label: 'Sign-in failed', title: 'Gmail rejected the sign-in', sub: 'Check the Gmail address and App Password in Settings, then press Reconnect.' };
      default:
        return { tone: 'is-off', label: 'Not set up', title: 'Not set up', sub: 'Add a Gmail address and App Password in Settings to mark orders paid automatically.' };
    }
  }

  function updateNavWatcher(status) {
    const d = describeWatcher(status);
    navWatcherStatus.classList.remove('is-off', 'is-warn', 'is-error');
    if (d.tone) navWatcherStatus.classList.add(d.tone);
    navWatcherText.textContent = `IMAP Stream: ${d.label}`;
  }

  // ==============================================================
  // 3. ONBOARDING WIZARD LOGIC
  // ==============================================================
  function setupOnboarding() {
    // Dropzone Click
    qrDropzone.addEventListener('click', () => qrFileInput.click());
    btnSelectQrFile.addEventListener('click', (e) => {
      e.stopPropagation();
      qrFileInput.click();
    });

    // File Selected
    qrFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('qrImage', file);

      showToast('Uploading & decoding QR code...');

      try {
        const res = await api('/api/merchant/upload-qr', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();

        if (data.success) {
          uploadedQrPath = data.qrImagePath;
          decodedUpiId = data.detectedUpiId;
          previewQrImg.src = data.qrImagePath;
          detectedUpiTag.textContent = `UPI ID: ${data.detectedUpiId}`;
          qrDetectionPreview.classList.remove('hidden');
          obUpiId.value = data.detectedUpiId;
          showToast(`QR Decoded: ${data.detectedUpiId}`);
        } else {
          showToast(data.error || 'Could not decode QR image');
        }
      } catch (err) {
        showToast('QR Upload failed');
      }
    });

    // Test Gmail IMAP Live
    btnTestGmailImap.addEventListener('click', async () => {
      const user = obGmailUser.value.trim();
      const pass = obGmailPass.value.trim();

      if (!user || !pass) {
        showToast('Please enter both Gmail address and App Password');
        return;
      }

      btnTestGmailImap.disabled = true;
      testBtnSpinner.classList.remove('hidden');
      testBtnText.textContent = 'Connecting to Gmail IMAP...';
      testFeedback.textContent = 'Establishing secure TLS connection...';

      try {
        const res = await api('/api/merchant/test-email', {
          method: 'POST',
          body: JSON.stringify({ gmailUser: user, gmailAppPass: pass })
        });
        const data = await res.json();

        if (data.success) {
          testFeedback.innerHTML = `<span style="color:#047857; font-weight:700;">✓ Success: Verified IMAP access (${data.inboxCount} messages in INBOX)</span>`;
          showToast('Gmail connection confirmed!');
        } else {
          testFeedback.innerHTML = `<span style="color:#DC2626;">✗ Failed: ${escapeHtml(data.error || 'Unknown error')}</span>`;
        }
      } catch (err) {
        testFeedback.textContent = 'Network error testing Gmail.';
      } finally {
        btnTestGmailImap.disabled = false;
        testBtnSpinner.classList.add('hidden');
        testBtnText.textContent = '⚡ Test Gmail IMAP Connection Live';
      }
    });

    btnCopyObApiKey.addEventListener('click', () => {
      navigator.clipboard.writeText(obApiKeyDisplay.textContent).then(() => {
        showToast('API Key copied to clipboard!');
      });
    });

    btnGoToDashboard.addEventListener('click', () => goDashboard());
  }

  // Global Slide Navigation function
  window.nextOnboardingSlide = function(stepNum) {
    activeOnboardingStep = stepNum;

    // Update Progress Step Pills
    document.querySelectorAll('.progress-step').forEach(step => {
      const s = parseInt(step.dataset.step);
      if (s === stepNum) {
        step.classList.add('active');
        step.classList.remove('completed');
      } else if (s < stepNum) {
        step.classList.remove('active');
        step.classList.add('completed');
      } else {
        step.classList.remove('active', 'completed');
      }
    });

    // Show correct slide
    document.querySelectorAll('.carousel-slide').forEach((slide, idx) => {
      if (idx + 1 === stepNum) {
        slide.classList.add('active');
      } else {
        slide.classList.remove('active');
      }
    });
  };

  // Global Tutorial Step Switcher
  window.setFamTutorialStep = function(stepIdx) {
    document.querySelectorAll('.tut-step-item').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.stepIdx) === stepIdx);
    });

    document.getElementById('tutStepIndicator').textContent = `Step ${stepIdx} of 4`;
    const ill = document.getElementById('tutIllustration');

    const stepsData = [
      {
        title: 'Tap Profile Icon',
        desc: 'Open FamApp on your phone and tap your top-left profile avatar.',
        color: '#2563EB'
      },
      {
        title: 'Settings & Alerts',
        desc: 'Scroll down the menu and tap on "Notifications & Alerts".',
        color: '#6366F1'
      },
      {
        title: 'Turn ON Email Alerts',
        desc: 'Toggle the switch for "Email notifications for received payments" to ON.',
        color: '#10B981'
      },
      {
        title: 'Verify Linked Gmail',
        desc: 'Ensure huntkum@gmail.com is listed as your primary notification address.',
        color: '#0F172A'
      }
    ];

    const data = stepsData[stepIdx - 1];
    ill.innerHTML = `
      <div class="phone-card-sim">
        <div class="sim-avatar" style="background: ${data.color}"></div>
        <div class="sim-title">${data.title}</div>
        <div class="sim-desc">${data.desc}</div>
      </div>
    `;
  };

  // Complete Onboarding Call
  window.finishOnboarding = async function() {
    if (!currentMerchant) return;

    const payload = {
      businessName: obBusinessName.value.trim() || currentMerchant.businessName,
      upiId: obUpiId.value.trim() || decodedUpiId,
      qrImagePath: uploadedQrPath,
      gmailUser: obGmailUser.value.trim(),
      gmailAppPass: obGmailPass.value.trim()
    };

    try {
      const res = await api('/api/merchant/complete-onboarding', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!data.success) {
        showToast(data.error || 'Could not complete onboarding.');
        return;
      }
      if (data.merchant) {
        currentMerchant = data.merchant;
        obGmailPass.value = '';
        obApiKeyDisplay.textContent = data.merchant.apiKey;

        // Launch celebratory confetti
        if (typeof confetti === 'function') {
          confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
        }

        window.nextOnboardingSlide(5);
      }
    } catch (e) {
      showToast('Could not complete onboarding.');
    }
  };

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }
});
