/**
 * suggest.js — Text selection popup, submission modal, and suggestion API.
 *
 * Features:
 *   - Floating popup on text selection ("Suggest Edit" / "Ask Question")
 *   - Submission modal for edits and questions
 *   - POST to eowiki_suggestions Xano endpoint
 *   - Reply posting for community Q&A
 */

import { esc } from './render.js';

var XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
var SUGGEST_POST = XANO_BASE + '/eo_wiki_suggestions';
var SUGGEST_GET  = XANO_BASE + '/eowiki_suggestions';

// ── State ────────────────────────────────────────────────────────────────────

var _popup = null;       // floating selection popup element
var _modal = null;       // submission modal element
var _currentContext = null; // { slug, contentId, contentType, selectedText, revisionId }

// ── Generate suggestion ID ───────────────────────────────────────────────────

function generateSuggestionId() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var id = 'sg_';
  for (var i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function generateToken() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var tok = '';
  for (var i = 0; i < 24; i++) {
    tok += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return tok;
}

// ── Xano API ─────────────────────────────────────────────────────────────────

function postSuggestionEvent(event) {
  return fetch(SUGGEST_POST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15000)
  }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

export function fetchSuggestionEvents(filter) {
  var url = SUGGEST_GET;
  if (filter) {
    var params = [];
    Object.keys(filter).forEach(function (k) {
      params.push(encodeURIComponent(k) + '=' + encodeURIComponent(filter[k]));
    });
    if (params.length) url += '?' + params.join('&');
  }
  return fetch(url, { signal: AbortSignal.timeout(15000) })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      return Array.isArray(data) ? data : (data.items || []);
    });
}

// ── Replay suggestion events into state ──────────────────────────────────────

export function replaySuggestions(events) {
  var suggestions = {};

  events.forEach(function (evt) {
    var subject = evt.subject || '';
    // Extract suggestion ID from subject like "suggestion:sg_abc123" or "suggestion:sg_abc123/rev:r_1"
    var match = subject.match(/^suggestion:(sg_[a-z0-9]+)/);
    if (!match) return;
    var sgId = match[1];

    if (!suggestions[sgId]) {
      suggestions[sgId] = {
        id: sgId,
        status: 'pending',
        type: 'edit',
        target_content_id: '',
        agent_name: 'anonymous',
        agent_contact: '',
        created_at: evt.created_at,
        updated_at: evt.created_at,
        revisions: [],
        replies: [],
        events: [],
        voteCount: 0,
        votes: {}
      };
    }

    var sg = suggestions[sgId];
    sg.events.push(evt);
    sg.updated_at = evt.created_at;

    var operand = {};
    try { operand = typeof evt.value === 'string' ? JSON.parse(evt.value) : (evt.value || {}); } catch (e) {}
    var ctx = evt.context || {};
    if (typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch (e) { ctx = {}; } }

    if (evt.op === 'INS') {
      // Check if this is a reply or a revision
      if (subject.indexOf('/reply:') > -1) {
        sg.replies.push({
          id: subject,
          content: operand.content || '',
          agent_name: ctx.agent_name || 'anonymous',
          ts: ctx.ts || evt.created_at,
          created_at: evt.created_at,
          voteCount: 0,
          votes: {}
        });
      } else {
        // Revision
        var rev = {
          rev_id: operand.rev_id || ('r_' + sg.revisions.length + 1),
          format: operand.format || 'markdown',
          content: operand.content || '',
          summary: operand.summary || '',
          selected_text: operand.selected_text || '',
          agent_name: ctx.agent_name || 'anonymous',
          ts: ctx.ts || evt.created_at
        };
        sg.revisions.push(rev);

        // Set metadata from first revision
        if (sg.revisions.length === 1) {
          sg.target_content_id = operand.target_content_id || '';
          sg.type = operand.type || 'edit';
          sg.agent_name = ctx.agent_name || 'anonymous';
          sg.agent_contact = ctx.agent_contact || '';
        }
      }
    } else if (evt.op === 'SIG') {
      var set = operand.set || operand;
      if (set.vote === 'up') {
        // Upvote — track on the suggestion or reply
        var voter = set.voter || '';
        if (subject.indexOf('/reply:') > -1) {
          // Vote on a reply
          var reply = sg.replies.find(function (r) { return r.id === subject; });
          if (reply) {
            if (!reply.votes) reply.votes = {};
            if (!reply.votes[voter]) { reply.votes[voter] = true; reply.voteCount = (reply.voteCount || 0) + 1; }
          }
        } else {
          // Vote on the suggestion itself
          if (!sg.votes) sg.votes = {};
          if (!sg.votes[voter]) { sg.votes[voter] = true; sg.voteCount = (sg.voteCount || 0) + 1; }
        }
      } else if (set.status) { sg.status = set.status; }
      if (set.merged_as) sg.merged_as = set.merged_as;
      if (set.reason) sg.reject_reason = set.reason;
    } else if (evt.op === 'NUL') {
      sg.status = 'deleted';
    }
  });

  return suggestions;
}

// ── Selection popup ──────────────────────────────────────────────────────────

function createPopup() {
  var el = document.createElement('div');
  el.className = 'eo-selection-popup';
  el.innerHTML =
    '<button class="eo-sel-btn eo-sel-edit" data-action="edit" title="Suggest an edit to this text">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
    ' Suggest Edit</button>' +
    '<button class="eo-sel-btn eo-sel-question" data-action="question" title="Ask a question about this text">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
    ' Ask Question</button>';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

function showPopup(x, y) {
  if (!_popup) _popup = createPopup();
  _popup.style.display = 'flex';
  // Position above the selection
  var pw = _popup.offsetWidth || 240;
  var left = Math.max(8, Math.min(x - pw / 2, window.innerWidth - pw - 8));
  var top = Math.max(8, y - 48);
  _popup.style.left = left + 'px';
  _popup.style.top = top + 'px';
}

function hidePopup() {
  if (_popup) _popup.style.display = 'none';
}

// ── Submission modal ─────────────────────────────────────────────────────────

function createModal() {
  var el = document.createElement('div');
  el.className = 'eo-suggest-overlay';
  el.innerHTML =
    '<div class="eo-suggest-modal">' +
      '<div class="eo-suggest-header">' +
        '<h3 class="eo-suggest-title">Submit</h3>' +
        '<button class="eo-suggest-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="eo-suggest-body">' +
        '<div class="eo-suggest-context">' +
          '<label>Selected text</label>' +
          '<blockquote class="eo-suggest-quote" id="eo-suggest-quote"></blockquote>' +
        '</div>' +
        '<div class="eo-suggest-field">' +
          '<label for="eo-suggest-content">Your <span id="eo-suggest-content-label">suggestion</span></label>' +
          '<textarea id="eo-suggest-content" rows="6" placeholder=""></textarea>' +
        '</div>' +
        '<div class="eo-suggest-field">' +
          '<label for="eo-suggest-summary">Summary <span class="eo-field-hint">(required — briefly describe your change)</span></label>' +
          '<input type="text" id="eo-suggest-summary" placeholder="e.g. Fixed typo in second paragraph">' +
        '</div>' +
        '<div class="eo-suggest-row">' +
          '<div class="eo-suggest-field eo-suggest-half">' +
            '<label for="eo-suggest-name">Your name <span class="eo-field-hint">(optional)</span></label>' +
            '<input type="text" id="eo-suggest-name" placeholder="anonymous">' +
          '</div>' +
          '<div class="eo-suggest-field eo-suggest-half">' +
            '<label for="eo-suggest-contact">Contact <span class="eo-field-hint">(optional)</span></label>' +
            '<input type="text" id="eo-suggest-contact" placeholder="email or handle">' +
          '</div>' +
        '</div>' +
        '<div class="eo-suggest-actions">' +
          '<button class="eo-suggest-cancel">Cancel</button>' +
          '<button class="eo-suggest-submit" id="eo-suggest-submit">Submit</button>' +
        '</div>' +
        '<div class="eo-suggest-status" id="eo-suggest-status"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  return el;
}

function openModal(type) {
  if (!_modal) _modal = createModal();

  var isQuestion = type === 'question';
  var title = _modal.querySelector('.eo-suggest-title');
  var contentLabel = document.getElementById('eo-suggest-content-label');
  var content = document.getElementById('eo-suggest-content');
  var summary = document.getElementById('eo-suggest-summary');
  var quote = document.getElementById('eo-suggest-quote');
  var status = document.getElementById('eo-suggest-status');

  title.textContent = isQuestion ? 'Ask a Question' : 'Suggest an Edit';
  contentLabel.textContent = isQuestion ? 'question' : 'suggested edit';
  content.placeholder = isQuestion
    ? 'What would you like to know about this text?'
    : 'Write your proposed replacement text or describe the change...';
  summary.placeholder = isQuestion
    ? 'e.g. How does this relate to the ALT operator?'
    : 'e.g. Fixed typo in second paragraph';

  // Pre-fill context
  if (_currentContext && _currentContext.selectedText) {
    quote.textContent = _currentContext.selectedText;
    _modal.querySelector('.eo-suggest-context').style.display = '';
  } else {
    _modal.querySelector('.eo-suggest-context').style.display = 'none';
  }

  // Reset form
  content.value = '';
  summary.value = '';
  status.textContent = '';
  status.className = 'eo-suggest-status';

  // Restore saved name/contact — use Matrix identity if logged in
  var mx = getMatrixUser();
  var savedName = mx ? (mx.display_name || mx.user_id) : (localStorage.getItem('eo-suggest-name') || '');
  var savedContact = mx ? mx.user_id : (localStorage.getItem('eo-suggest-contact') || '');
  document.getElementById('eo-suggest-name').value = savedName;
  document.getElementById('eo-suggest-contact').value = savedContact;
  if (mx) {
    document.getElementById('eo-suggest-name').readOnly = true;
    document.getElementById('eo-suggest-contact').readOnly = true;
  } else {
    document.getElementById('eo-suggest-name').readOnly = false;
    document.getElementById('eo-suggest-contact').readOnly = false;
  }

  _modal.classList.add('open');
  _modal.setAttribute('data-type', type);
  document.body.style.overflow = 'hidden';
  content.focus();
}

function closeModal() {
  if (_modal) {
    _modal.classList.remove('open');
    document.body.style.overflow = '';
  }
}

function handleSubmit() {
  var type = _modal.getAttribute('data-type') || 'edit';
  var content = document.getElementById('eo-suggest-content').value.trim();
  var summary = document.getElementById('eo-suggest-summary').value.trim();
  var name = document.getElementById('eo-suggest-name').value.trim();
  var contact = document.getElementById('eo-suggest-contact').value.trim();
  var status = document.getElementById('eo-suggest-status');
  var submitBtn = document.getElementById('eo-suggest-submit');

  if (!content) {
    status.textContent = 'Please enter your ' + (type === 'question' ? 'question' : 'suggestion') + '.';
    status.className = 'eo-suggest-status eo-status-error';
    return;
  }
  if (!summary) {
    status.textContent = 'Please provide a brief summary.';
    status.className = 'eo-suggest-status eo-status-error';
    return;
  }

  // Save name/contact for next time
  if (name) localStorage.setItem('eo-suggest-name', name);
  if (contact) localStorage.setItem('eo-suggest-contact', contact);

  var sgId = generateSuggestionId();
  var token = generateToken();
  var now = new Date().toISOString();

  var event = {
    op: 'INS',
    subject: 'suggestion:' + sgId + '/rev:r_1',
    predicate: 'eo.op',
    value: JSON.stringify({
      type: type,
      target_content_id: _currentContext ? _currentContext.contentId : '',
      target_revision_id: _currentContext ? (_currentContext.revisionId || '') : '',
      format: 'markdown',
      content: content,
      selected_text: _currentContext ? (_currentContext.selectedText || '') : '',
      summary: summary
    }),
    context: JSON.stringify({
      agent: sgId,
      agent_name: name || 'anonymous',
      agent_contact: contact || '',
      ts: now,
      token: token
    })
  };

  submitBtn.disabled = true;
  status.textContent = 'Submitting...';
  status.className = 'eo-suggest-status';

  postSuggestionEvent(event)
    .then(function () {
      status.innerHTML = 'Submitted! Track your ' +
        (type === 'question' ? 'question' : 'suggestion') +
        ': <a href="/suggestion/' + sgId + '/">/suggestion/' + sgId + '/</a>';
      status.className = 'eo-suggest-status eo-status-success';
      submitBtn.disabled = false;

      // Close modal after delay
      setTimeout(function () { closeModal(); }, 3000);
    })
    .catch(function (err) {
      console.error('[suggest] Submit failed:', err);
      status.textContent = 'Failed to submit. Please try again.';
      status.className = 'eo-suggest-status eo-status-error';
      submitBtn.disabled = false;
    });
}

// ── Post a reply to a suggestion (community Q&A) ─────────────────────────────

export function postReply(suggestionId, content, name, contact) {
  var now = new Date().toISOString();
  var replyNum = Date.now();

  var event = {
    op: 'INS',
    subject: 'suggestion:' + suggestionId + '/reply:' + replyNum,
    predicate: 'eo.op',
    value: JSON.stringify({
      content: content
    }),
    context: JSON.stringify({
      agent: 'reply_' + replyNum,
      agent_name: name || 'anonymous',
      agent_contact: contact || '',
      ts: now
    })
  };

  return postSuggestionEvent(event);
}

// ── Create a new standalone topic (community discussion) ─────────────────────

export function createTopic(title, content, name, contact) {
  var sgId = generateSuggestionId();
  var token = generateToken();
  var now = new Date().toISOString();

  var event = {
    op: 'INS',
    subject: 'suggestion:' + sgId + '/rev:r_1',
    predicate: 'eo.op',
    value: JSON.stringify({
      type: 'topic',
      target_content_id: '',
      format: 'markdown',
      content: content,
      summary: title
    }),
    context: JSON.stringify({
      agent: sgId,
      agent_name: name || 'anonymous',
      agent_contact: contact || '',
      ts: now,
      token: token
    })
  };

  return postSuggestionEvent(event).then(function () {
    return sgId;
  });
}

// ── Upvoting ─────────────────────────────────────────────────────────────────

/**
 * Get a stable anonymous voter ID. Uses localStorage so repeat votes are
 * deduplicated in the replay. If a Matrix user is logged in, use their MXID.
 */
function getVoterId() {
  var mx = getMatrixUser();
  if (mx) return 'mx:' + mx.user_id;
  var id = localStorage.getItem('eo-voter-id');
  if (!id) {
    id = 'anon_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('eo-voter-id', id);
  }
  return id;
}

/**
 * Submit an upvote for a suggestion or a specific reply.
 * @param {string} suggestionId - e.g. "sg_abc123"
 * @param {string} [replySubject] - full reply subject to vote on a reply, or omit for the suggestion itself
 */
export function postUpvote(suggestionId, replySubject) {
  var voterId = getVoterId();
  var now = new Date().toISOString();
  var target = replySubject || ('suggestion:' + suggestionId);

  var event = {
    op: 'SIG',
    subject: target,
    predicate: 'eo.op',
    value: JSON.stringify({ vote: 'up', voter: voterId }),
    context: JSON.stringify({
      agent: voterId,
      agent_name: getDisplayName(),
      ts: now
    })
  };

  return postSuggestionEvent(event);
}

/**
 * During replay, tally votes per subject. Returns map: subject → { count, voters }
 */
export function tallyVotes(events) {
  var votes = {};
  events.forEach(function (evt) {
    if (evt.op !== 'SIG') return;
    var operand = {};
    try { operand = typeof evt.value === 'string' ? JSON.parse(evt.value) : (evt.value || {}); } catch (e) {}
    if (operand.vote !== 'up') return;
    var voter = operand.voter || '';
    var subject = evt.subject || '';
    if (!votes[subject]) votes[subject] = { count: 0, voters: {} };
    // Deduplicate: one vote per voter per subject
    if (!votes[subject].voters[voter]) {
      votes[subject].voters[voter] = true;
      votes[subject].count++;
    }
  });
  return votes;
}

// ── Matrix authentication (optional) ─────────────────────────────────────────

var _matrixUser = null; // { user_id, access_token, homeserver, display_name }

/** Get the current Matrix user, if logged in. */
export function getMatrixUser() {
  if (_matrixUser) return _matrixUser;
  try {
    var stored = localStorage.getItem('eo-matrix-user');
    if (stored) _matrixUser = JSON.parse(stored);
  } catch (e) {}
  return _matrixUser;
}

/** Get the display name — Matrix name if logged in, else localStorage name, else 'anonymous'. */
export function getDisplayName() {
  var mx = getMatrixUser();
  if (mx && mx.display_name) return mx.display_name;
  if (mx && mx.user_id) return mx.user_id;
  return localStorage.getItem('eo-suggest-name') || 'anonymous';
}

/**
 * Log in with Matrix credentials.
 * @param {string} homeserver - e.g. "https://matrix.org" or "matrix.org"
 * @param {string} user - Matrix user ID (e.g. "@alice:matrix.org") or local part
 * @param {string} password
 */
export function matrixLogin(homeserver, user, password) {
  // Normalise homeserver URL
  if (homeserver.indexOf('http') !== 0) homeserver = 'https://' + homeserver;
  homeserver = homeserver.replace(/\/+$/, '');

  var body = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: user.replace(/^@/, '').split(':')[0] },
    password: password
  };

  return fetch(homeserver + '/_matrix/client/v3/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (err) { throw new Error(err.error || 'Login failed'); });
      return r.json();
    })
    .then(function (data) {
      _matrixUser = {
        user_id: data.user_id,
        access_token: data.access_token,
        homeserver: homeserver,
        display_name: data.user_id
      };
      localStorage.setItem('eo-matrix-user', JSON.stringify(_matrixUser));

      // Try to fetch display name
      return fetch(homeserver + '/_matrix/client/v3/profile/' + encodeURIComponent(data.user_id) + '/displayname', {
        headers: { 'Authorization': 'Bearer ' + data.access_token }
      })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (profile) {
          if (profile.displayname) {
            _matrixUser.display_name = profile.displayname;
            localStorage.setItem('eo-matrix-user', JSON.stringify(_matrixUser));
          }
          return _matrixUser;
        })
        .catch(function () { return _matrixUser; });
    });
}

/** Log out of Matrix. */
export function matrixLogout() {
  _matrixUser = null;
  localStorage.removeItem('eo-matrix-user');
}

// ── Setup: wire text selection + modal events ────────────────────────────────

export function setupSuggestUI() {
  // Text selection popup
  document.addEventListener('mouseup', function (e) {
    // Ignore clicks on the popup itself or the modal
    if (e.target.closest('.eo-selection-popup') || e.target.closest('.eo-suggest-overlay')) return;

    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : '';

    if (text.length < 3) {
      hidePopup();
      return;
    }

    // Only activate on article content areas
    var articleEl = e.target.closest('.wiki-body, .article-main, .wiki-content, .blog-body, .exp-body, .content-body');
    if (!articleEl) {
      hidePopup();
      return;
    }

    // Gather context from the article
    var article = articleEl.closest('[data-eo-target]');
    var contentId = article ? article.getAttribute('data-eo-target') : '';
    var slug = '';
    if (contentId) {
      var parts = contentId.split(':');
      slug = parts.slice(1).join(':');
    }

    _currentContext = {
      slug: slug,
      contentId: contentId,
      contentType: contentId ? contentId.split(':')[0] : '',
      selectedText: text.slice(0, 500), // cap at 500 chars
      revisionId: ''
    };

    // Position popup near selection
    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    showPopup(rect.left + rect.width / 2, rect.top + window.scrollY);
  });

  // Hide popup on scroll or click elsewhere
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest('.eo-selection-popup')) {
      hidePopup();
    }
  });

  // Popup button clicks
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.eo-sel-btn');
    if (!btn) return;
    e.preventDefault();
    var action = btn.getAttribute('data-action');
    hidePopup();
    openModal(action);
  });

  // Modal events (delegated since modal is created lazily)
  document.addEventListener('click', function (e) {
    if (e.target.closest('.eo-suggest-close') || e.target.closest('.eo-suggest-cancel')) {
      closeModal();
      return;
    }
    if (e.target.closest('.eo-suggest-submit')) {
      handleSubmit();
      return;
    }
    // Close on overlay click
    if (e.target.classList.contains('eo-suggest-overlay')) {
      closeModal();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _modal && _modal.classList.contains('open')) {
      closeModal();
    }
  });
}

// ── Standalone suggest form (for /suggest/<slug> route, not highlight-based) ─

export function openSuggestForm(slug, contentId, type) {
  _currentContext = {
    slug: slug,
    contentId: contentId,
    contentType: contentId ? contentId.split(':')[0] : '',
    selectedText: '',
    revisionId: ''
  };
  openModal(type || 'edit');
}
