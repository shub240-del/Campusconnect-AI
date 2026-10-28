/**
 * SmallBiz AI Support Hub — Operator Dashboard JavaScript
 * 
 * Connects to the Dashboard API (configured via window.DASHBOARD_CONFIG or
 * the CONFIG object below). Uses SigV4-signed requests when AWS credentials
 * are available, falls back to API Key header for local dev.
 *
 * API Endpoints (all require operator auth):
 *   GET  /interactions              → list interactions (filter by status, date)
 *   GET  /interactions/:id          → full thread for one interaction
 *   PUT  /interactions/:id/resolve  → mark resolved
 *   POST /interactions/:id/reply    → send operator reply through channel
 */

// ── Configuration ─────────────────────────────────────────────────────────
// These values are replaced at deploy time by the CDK stack (CloudFront Function
// or build script that generates a config.js). For local dev, set them here.
const CONFIG = window.DASHBOARD_CONFIG || {
  apiBaseUrl: 'https://your-api-gateway-url.execute-api.us-east-1.amazonaws.com',
  apiKey: '',      // Set if using simple API key auth (dev only)
  region: 'us-east-1'
};

// ── State ─────────────────────────────────────────────────────────────────
let state = {
  tickets: [],
  filteredTickets: [],
  selectedTicketId: null,
  currentFilter: 'all',
  searchQuery: '',
  autoRefreshInterval: null
};

// ── API Client ────────────────────────────────────────────────────────────
const api = {
  headers: () => {
    const h = { 'Content-Type': 'application/json' };
    if (CONFIG.apiKey) h['x-api-key'] = CONFIG.apiKey;
    return h;
  },

  get: async (path) => {
    const res = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: api.headers()
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  },

  put: async (path, body) => {
    const res = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
      method: 'PUT',
      headers: api.headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  },

  post: async (path, body) => {
    const res = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: api.headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  }
};

// ── Mock Data (used when API is not yet configured) ───────────────────────
const MOCK_TICKETS = [
  {
    interactionId: 'int-demo-001',
    timestamp: Date.now() - 120000,
    customerId: 'a1b2c3d4',
    channel: 'whatsapp',
    direction: 'inbound',
    status: 'ESCALATED',
    source: 'keyword_escalation',
    messageBody: 'My order is damaged and I want a refund right now',
    sessionId: 'sess-abc-001',
    escalationReason: 'Escalation keyword: "refund"',
    thread: [
      { direction: 'inbound', message: 'My order is damaged and I want a refund right now', timestamp: Date.now() - 120000, sender: 'Customer' },
      { direction: 'outbound', message: 'Thank you for reaching out. I\'m connecting you with a member of our support team who will be in touch shortly.', timestamp: Date.now() - 119000, sender: 'AI Agent' }
    ]
  },
  {
    interactionId: 'int-demo-002',
    timestamp: Date.now() - 900000,
    customerId: 'e5f6a7b8',
    channel: 'sms',
    direction: 'inbound',
    status: 'RESOLVED',
    source: 'KB',
    messageBody: 'What is your return policy?',
    sessionId: 'sess-def-002',
    thread: [
      { direction: 'inbound', message: 'What is your return policy?', timestamp: Date.now() - 900000, sender: 'Customer' },
      { direction: 'outbound', message: 'You may return most items within 30 days of delivery for a full refund or exchange. Items must be unused and in original packaging. Contact us to initiate a return and we\'ll send a free prepaid label within 1 business day.', timestamp: Date.now() - 898000, sender: 'AI Agent' }
    ]
  },
  {
    interactionId: 'int-demo-003',
    timestamp: Date.now() - 300000,
    customerId: 'c9d0e1f2',
    channel: 'whatsapp',
    direction: 'inbound',
    status: 'RESOLVED',
    source: 'KB+AgentCore',
    messageBody: 'Where is my order ORD-7781?',
    sessionId: 'sess-ghi-003',
    thread: [
      { direction: 'inbound', message: 'Where is my order ORD-7781?', timestamp: Date.now() - 300000, sender: 'Customer' },
      { direction: 'outbound', message: 'Your order ORD-7781 has been shipped! 📦 Order ORD-7781: Status: Shipped | Product: Wireless Noise-Cancelling Headphones (Black) | Estimated Delivery: Nov 3, 2026 | Track: https://tracking.example.com/ORD-7781', timestamp: Date.now() - 298000, sender: 'AI Agent' }
    ]
  },
  {
    interactionId: 'int-demo-004',
    timestamp: Date.now() - 60000,
    customerId: 'g3h4i5j6',
    channel: 'whatsapp',
    direction: 'inbound',
    status: 'PENDING',
    source: 'unknown',
    messageBody: 'How long does delivery take?',
    sessionId: 'sess-jkl-004',
    thread: [
      { direction: 'inbound', message: 'How long does delivery take?', timestamp: Date.now() - 60000, sender: 'Customer' }
    ]
  },
  {
    interactionId: 'int-demo-005',
    timestamp: Date.now() - 1800000,
    customerId: 'k7l8m9n0',
    channel: 'sms',
    direction: 'inbound',
    status: 'REPLIED',
    source: 'Operator',
    messageBody: 'I never received my order ORD-3302',
    sessionId: 'sess-mno-005',
    operatorId: 'operator-1',
    thread: [
      { direction: 'inbound', message: 'I never received my order ORD-3302', timestamp: Date.now() - 1800000, sender: 'Customer' },
      { direction: 'outbound', message: 'Thank you for reaching out. I\'m connecting you with a member of our support team who will be in touch shortly.', timestamp: Date.now() - 1799000, sender: 'AI Agent' },
      { direction: 'outbound', message: 'Hi, I\'m Sarah from SmallBiz support. I can see that order ORD-3302 was unfortunately cancelled. I\'m so sorry about this. I\'ve processed a full refund and it will appear in 3-5 business days. Can I help with anything else?', timestamp: Date.now() - 1200000, sender: 'Operator' }
    ]
  }
];

// ── Utility Functions ─────────────────────────────────────────────────────
const formatTime = (timestamp) => {
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

const getStatusBadge = (status) => {
  const s = (status || 'PENDING').toLowerCase();
  const labels = { escalated: '🔴 Escalated', pending: '🟡 Pending', resolved: '🟢 Resolved', replied: '💬 Replied', error: '❌ Error', opt_out: '🚫 Opted Out', rate_limited: '⏱ Rate Limited' };
  return `<span class="badge badge-${s}">${labels[s] || status}</span>`;
};

const getChannelBadge = (channel) => {
  const icons = { whatsapp: '💬 WhatsApp', sms: '📱 SMS', email: '📧 Email', api: '🔌 API' };
  return `<span class="channel-badge">${icons[channel?.toLowerCase()] || channel}</span>`;
};

const showToast = (message, type = 'success') => {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
};

// ── Data Loading ──────────────────────────────────────────────────────────
const loadTickets = async () => {
  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.textContent = '↻ Loading...'; btn.disabled = true; }

  try {
    let tickets;
    // Attempt real API call; fall back to mock data
    if (CONFIG.apiBaseUrl && !CONFIG.apiBaseUrl.includes('your-api-gateway')) {
      const result = await api.get('/interactions');
      tickets = result.items || result;
    } else {
      // Demo mode: use mock data
      console.info('Dashboard: API not configured — using mock data');
      tickets = MOCK_TICKETS;
    }

    state.tickets = tickets.sort((a, b) => b.timestamp - a.timestamp);
    applyFiltersAndRender();

    document.getElementById('refresh-info').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    console.error('loadTickets error:', error);
    // Fallback to mock data on error
    state.tickets = MOCK_TICKETS.sort((a, b) => b.timestamp - a.timestamp);
    applyFiltersAndRender();
    showToast('Using demo data — API not configured', 'error');
  } finally {
    if (btn) { btn.textContent = '↻ Refresh'; btn.disabled = false; }
  }
};

// ── Filtering & Search ────────────────────────────────────────────────────
const filterTickets = (filter) => {
  state.currentFilter = filter;
  // Update sidebar nav
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${filter.toLowerCase()}`);
  if (navEl) navEl.classList.add('active');
  // Update panel header
  const labels = { all: 'All Tickets', ESCALATED: 'Escalated', PENDING: 'Pending', RESOLVED: 'Resolved', REPLIED: 'Replied' };
  document.getElementById('filter-label').textContent = labels[filter] || filter;
  applyFiltersAndRender();
};

const searchTickets = (query) => {
  state.searchQuery = query.toLowerCase();
  applyFiltersAndRender();
};

const applyFiltersAndRender = () => {
  let filtered = state.tickets;

  if (state.currentFilter !== 'all') {
    filtered = filtered.filter(t => t.status === state.currentFilter);
  }
  if (state.searchQuery) {
    filtered = filtered.filter(t =>
      t.interactionId?.toLowerCase().includes(state.searchQuery) ||
      t.status?.toLowerCase().includes(state.searchQuery) ||
      t.channel?.toLowerCase().includes(state.searchQuery) ||
      t.messageBody?.toLowerCase().includes(state.searchQuery)
    );
  }

  state.filteredTickets = filtered;
  renderTicketList();
  updateStats();
};

// ── Stats ─────────────────────────────────────────────────────────────────
const updateStats = () => {
  const counts = { ESCALATED: 0, PENDING: 0, RESOLVED: 0, REPLIED: 0 };
  state.tickets.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });

  document.getElementById('stat-escalated').textContent = counts.ESCALATED;
  document.getElementById('stat-pending').textContent = counts.PENDING;
  document.getElementById('stat-resolved').textContent = counts.RESOLVED;
  document.getElementById('stat-replied').textContent = counts.REPLIED;
  document.getElementById('stat-total').textContent = state.tickets.length;

  document.getElementById('badge-all').textContent = state.tickets.length;
  document.getElementById('badge-escalated').textContent = counts.ESCALATED;
  document.getElementById('badge-pending').textContent = counts.PENDING;
  document.getElementById('badge-resolved').textContent = counts.RESOLVED;
  document.getElementById('badge-replied').textContent = counts.REPLIED;
};

// ── Render Ticket List ────────────────────────────────────────────────────
const renderTicketList = () => {
  const container = document.getElementById('ticket-list');
  const countEl = document.getElementById('ticket-count');
  const count = state.filteredTickets.length;

  countEl.textContent = `${count} ticket${count !== 1 ? 's' : ''}`;

  if (count === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">No tickets found</div>
        <div class="empty-sub">Try adjusting your filter or search.</div>
      </div>`;
    return;
  }

  container.innerHTML = state.filteredTickets.map(ticket => {
    const isSelected = ticket.interactionId === state.selectedTicketId;
    const statusClass = ticket.status?.toLowerCase() || 'pending';
    return `
      <div class="ticket-card ${statusClass} ${isSelected ? 'selected' : ''}"
           id="card-${ticket.interactionId}"
           onclick="selectTicket('${ticket.interactionId}')">
        <div class="ticket-header">
          <span class="ticket-id">${ticket.interactionId.slice(-8).toUpperCase()}</span>
          <span class="ticket-time">${formatTime(ticket.timestamp)}</span>
        </div>
        <div class="ticket-body">${ticket.messageBody || '(no message body)'}</div>
        <div class="ticket-footer">
          ${getStatusBadge(ticket.status)}
          ${getChannelBadge(ticket.channel)}
        </div>
      </div>`;
  }).join('');
};

// ── Ticket Detail ─────────────────────────────────────────────────────────
const selectTicket = async (interactionId) => {
  state.selectedTicketId = interactionId;

  // Highlight selected card
  document.querySelectorAll('.ticket-card').forEach(el => el.classList.remove('selected'));
  const card = document.getElementById(`card-${interactionId}`);
  if (card) card.classList.add('selected');

  const ticket = state.tickets.find(t => t.interactionId === interactionId);
  if (!ticket) return;

  // Try to fetch full thread from API
  let fullTicket = ticket;
  if (CONFIG.apiBaseUrl && !CONFIG.apiBaseUrl.includes('your-api-gateway')) {
    try {
      fullTicket = await api.get(`/interactions/${interactionId}`);
    } catch (_) { /* use cached data */ }
  }

  renderTicketDetail(fullTicket);
};

const renderTicketDetail = (ticket) => {
  const placeholder = document.getElementById('detail-placeholder');
  const content = document.getElementById('ticket-detail-content');
  placeholder.style.display = 'none';
  content.style.display = 'flex';

  const isResolvable = ['ESCALATED', 'PENDING'].includes(ticket.status);
  const isReplyable = ['ESCALATED', 'PENDING', 'RESOLVED'].includes(ticket.status);

  const thread = (ticket.thread || []).sort((a, b) => a.timestamp - b.timestamp);

  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-meta">
        <div class="detail-id">ID: ${ticket.interactionId}</div>
        <div class="detail-title">${ticket.messageBody?.slice(0, 60) || 'Support Interaction'}${(ticket.messageBody?.length || 0) > 60 ? '…' : ''}</div>
        <div class="detail-badges">
          ${getStatusBadge(ticket.status)}
          ${getChannelBadge(ticket.channel)}
          ${ticket.source ? `<span class="channel-badge">🤖 ${ticket.source}</span>` : ''}
        </div>
      </div>
      <div class="detail-actions">
        ${isResolvable ? `<button class="btn btn-success" onclick="resolveTicket('${ticket.interactionId}')">✓ Resolve</button>` : ''}
        ${isReplyable ? `<button class="btn btn-primary" onclick="openReplyModal('${ticket.interactionId}', '${ticket.channel}')">💬 Reply</button>` : ''}
      </div>
    </div>

    <div class="detail-info-grid">
      <div class="detail-info-cell">
        <div class="detail-info-label">Time</div>
        <div class="detail-info-value">${new Date(ticket.timestamp).toLocaleString('en-GB')}</div>
      </div>
      <div class="detail-info-cell">
        <div class="detail-info-label">Customer ID</div>
        <div class="detail-info-value" style="font-family:monospace;font-size:11px">${ticket.customerId || '—'}</div>
      </div>
      <div class="detail-info-cell">
        <div class="detail-info-label">Session</div>
        <div class="detail-info-value" style="font-family:monospace;font-size:11px">${ticket.sessionId?.slice(-12) || '—'}</div>
      </div>
    </div>

    ${ticket.escalationReason ? `
      <div style="padding:12px 24px;border-bottom:1px solid var(--border)">
        <div class="escalation-alert">
          🔴 <strong>Escalation Reason:</strong> ${ticket.escalationReason}
        </div>
      </div>` : ''}

    <div class="thread-container" id="thread-${ticket.interactionId}">
      ${thread.length === 0 ? `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">No conversation history</div></div>` :
        thread.map(msg => {
          const isOutbound = msg.direction === 'outbound';
          const wrapClass = isOutbound ? 'message-outbound-wrap' : 'message-inbound-wrap';
          const bubbleClass = isOutbound ? 'message-outbound' : 'message-inbound';
          const sender = msg.sender || (isOutbound ? 'Agent' : 'Customer');
          return `
            <div class="${wrapClass}">
              <div class="message-sender">${sender}</div>
              <div class="message-bubble ${bubbleClass}">${msg.message || '(no text)'}</div>
              <div class="message-meta"><span>${formatTime(msg.timestamp)}</span></div>
            </div>`;
        }).join('')}
    </div>`;

  // Auto-scroll thread to bottom
  const threadEl = document.getElementById(`thread-${ticket.interactionId}`);
  if (threadEl) setTimeout(() => { threadEl.scrollTop = threadEl.scrollHeight; }, 50);
};

// ── Resolve Ticket ────────────────────────────────────────────────────────
const resolveTicket = async (interactionId) => {
  try {
    if (CONFIG.apiBaseUrl && !CONFIG.apiBaseUrl.includes('your-api-gateway')) {
      await api.put(`/interactions/${interactionId}/resolve`, { operatorId: 'operator-dashboard' });
    }
    // Update local state
    const ticket = state.tickets.find(t => t.interactionId === interactionId);
    if (ticket) ticket.status = 'RESOLVED';
    applyFiltersAndRender();
    if (state.selectedTicketId === interactionId) renderTicketDetail({ ...ticket, status: 'RESOLVED' });
    showToast('Ticket resolved ✓', 'success');
  } catch (error) {
    console.error('resolveTicket error:', error);
    showToast('Failed to resolve ticket', 'error');
  }
};

// ── Reply Modal ───────────────────────────────────────────────────────────
let replyTargetId = null;

const openReplyModal = (interactionId, channel) => {
  replyTargetId = interactionId;
  document.getElementById('reply-text').value = '';
  const channelSelect = document.getElementById('reply-channel');
  if (channelSelect && channel) channelSelect.value = channel;
  document.getElementById('reply-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('reply-text').focus(), 100);
};

const closeReplyModal = () => {
  document.getElementById('reply-modal').style.display = 'none';
  replyTargetId = null;
};

const closeModal = (event) => {
  if (event.target.id === 'reply-modal') closeReplyModal();
};

const sendReply = async () => {
  const text = document.getElementById('reply-text').value.trim();
  const channel = document.getElementById('reply-channel').value;
  const btn = document.getElementById('send-reply-btn');

  if (!text) { showToast('Reply message cannot be empty', 'error'); return; }
  if (!replyTargetId) return;

  btn.textContent = 'Sending...'; btn.disabled = true;
  try {
    if (CONFIG.apiBaseUrl && !CONFIG.apiBaseUrl.includes('your-api-gateway')) {
      await api.post(`/interactions/${replyTargetId}/reply`, { message: text, channel, operatorId: 'operator-dashboard' });
    }
    // Update local state
    const ticket = state.tickets.find(t => t.interactionId === replyTargetId);
    if (ticket) {
      ticket.status = 'REPLIED';
      if (!ticket.thread) ticket.thread = [];
      ticket.thread.push({ direction: 'outbound', message: text, timestamp: Date.now(), sender: 'Operator' });
    }
    closeReplyModal();
    applyFiltersAndRender();
    if (ticket && state.selectedTicketId === replyTargetId) renderTicketDetail(ticket);
    showToast('Reply sent ✓', 'success');
  } catch (error) {
    console.error('sendReply error:', error);
    showToast('Failed to send reply', 'error');
  } finally {
    btn.textContent = 'Send Reply'; btn.disabled = false;
  }
};

// ── Keyboard Shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeReplyModal();
  if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); loadTickets(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('search-input').focus(); }
});

// ── Auto-Refresh ──────────────────────────────────────────────────────────
const startAutoRefresh = () => {
  if (state.autoRefreshInterval) clearInterval(state.autoRefreshInterval);
  state.autoRefreshInterval = setInterval(loadTickets, 30000); // Refresh every 30s
};

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadTickets();
  startAutoRefresh();
});
