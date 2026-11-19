/*
 CubePlanner — business accounts: sign-in by emailed link, the business
 a user belongs to, and the products that business shares.

 Everything here talks to Supabase. With no configuration (js/config.js)
 or no connection library on the page, `SPCloud.available` is false and
 the site works on its own, as it did before accounts existed.

 The rules about who may see and change what are enforced by the
 database (supabase/schema.sql), not by this file.
*/
(function (root) {
  'use strict';
  var config = root.CUBEPLANNER_CONFIG, library = root.supabase;
  var client = null;
  try {
    if (config && config.supabaseUrl && config.supabaseKey && library && library.createClient) {
      client = library.createClient(config.supabaseUrl, config.supabaseKey);
    }
  } catch (error) {
    client = null;
  }

  var Cloud = {
    available: !!client,
    /** The signed-in user ({ id, email }), or null. */
    user: null,
    /** Every business the user belongs to: { id, name, role }. */
    businesses: [],
    /** The business being worked in. */
    business: null,
    ready: false,
  };
  var listener = function () {};
  var CHOICE = 'cubeplanner.business';

  function unwrap(result) {
    if (result.error) throw new Error(result.error.message || 'The server refused that.');
    return result.data;
  }

  /** Field names here ↔ column names in the database. */
  function fromRow(row) {
    return {
      id: row.id, name: row.name, sku: row.sku || '', l: +row.length_cm, w: +row.width_cm, h: +row.height_cm,
      weight: +row.weight_kg || 0, tippable: !!row.tippable, colour: row.colour || null, qty: 0,
      topLoad: row.top_load_kg === null || row.top_load_kg === undefined ? null : +row.top_load_kg,
    };
  }
  function toRow(item) {
    var row = {
      name: String(item.name || 'Carton').slice(0, 200), sku: item.sku || null,
      length_cm: Math.round(item.l * 10) / 10, width_cm: Math.round(item.w * 10) / 10, height_cm: Math.round(item.h * 10) / 10,
      weight_kg: item.weight > 0 ? Math.round(item.weight * 100) / 100 : null,
      tippable: !!item.tippable, colour: item.colour || null,
    };
    // Stacking limits are shared once the database has the column for them (supabase/stacking.sql).
    if (Cloud.stacking) row.top_load_kg = item.topLoad === null || item.topLoad === undefined ? null : Math.round(item.topLoad * 100) / 100;
    return row;
  }

  /** Works out who is signed in and which businesses they belong to. */
  async function refresh() {
    var session = unwrap(await client.auth.getSession()).session;
    Cloud.user = session ? { id: session.user.id, email: session.user.email || '' } : null;
    Cloud.businesses = [];
    Cloud.business = null;
    if (Cloud.user) {
      // Join any business that has invited this email address.
      try { unwrap(await client.rpc('accept_invitations')); } catch (ignore) { /* nothing to accept */ }
      // With the paywall installed (supabase/billing.sql) each business
      // carries its plan; before that the columns do not exist yet.
      var answer = await client.from('members').select('role, business:businesses(id, name, plan_status, stripe_customer_id)').eq('user_id', Cloud.user.id);
      if (answer.error) answer = await client.from('members').select('role, business:businesses(id, name)').eq('user_id', Cloud.user.id);
      var rows = unwrap(answer);
      Cloud.businesses = rows.filter(function (r) { return r.business; }).map(function (r) {
        return { id: r.business.id, name: r.business.name, role: r.role, plan: r.business.plan_status, billed: !!r.business.stripe_customer_id };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var wanted = null;
      try { wanted = root.localStorage.getItem(CHOICE); } catch (ignore) { /* storage is off */ }
      Cloud.business = Cloud.businesses.filter(function (b) { return b.id === wanted; })[0] || Cloud.businesses[0] || null;
    }
    Cloud.ready = true;
  }

  /** Starts watching for sign-in and sign-out; `onChange` is called after each. */
  Cloud.start = function (onChange) {
    if (!client) return;
    listener = onChange || listener;
    var busy = false, again = false;
    function update() {
      if (busy) { again = true; return; }
      busy = true;
      refresh().catch(function (error) { Cloud.error = error.message; }).then(function () {
        busy = false;
        listener();
        if (again) { again = false; update(); }
      });
    }
    client.auth.onAuthStateChange(function (event) {
      // Not inside the callback itself: the library forbids calling it back from here.
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') setTimeout(update, 0);
    });
  };

  /** Emails a sign-in link. The link brings the person back to this page, signed in. */
  Cloud.sendLink = async function (email) {
    unwrap(await client.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: root.location.origin + root.location.pathname },
    }));
  };

  /** Signs in with a password the user has set. */
  Cloud.signIn = async function (email, password) {
    unwrap(await client.auth.signInWithPassword({ email: email, password: password }));
  };

  /** Sets (or changes) the signed-in user's password. */
  Cloud.setPassword = async function (password) {
    unwrap(await client.auth.updateUser({ password: password }));
  };

  Cloud.signOut = async function () {
    unwrap(await client.auth.signOut());
  };

  Cloud.choose = function (businessId) {
    var found = Cloud.businesses.filter(function (b) { return b.id === businessId; })[0];
    if (!found) return;
    Cloud.business = found;
    try { root.localStorage.setItem(CHOICE, found.id); } catch (ignore) { /* storage is off */ }
    listener();
  };

  /** Creates a business with the signed-in user as its admin. */
  Cloud.createBusiness = async function (name) {
    var id = unwrap(await client.rpc('create_business', { business_name: name }));
    try { root.localStorage.setItem(CHOICE, id); } catch (ignore) { /* storage is off */ }
    await refresh();
    listener();
  };

  Cloud.isAdmin = function () { return !!(Cloud.business && Cloud.business.role === 'admin'); };

  /** The business may use its own products: it has a paid plan, or there is no paywall yet. */
  Cloud.paid = function () {
    var business = Cloud.business;
    if (!business) return false;
    return business.plan === undefined || business.plan === 'active' || business.plan === 'past_due' || business.plan === 'comped';
  };

  /** Looks again at who is signed in and what their business's plan is. */
  Cloud.recheck = async function () {
    await refresh();
    listener();
  };

  /**
   Asks the server for a Stripe page: 'checkout' to subscribe, 'portal'
   to manage the subscription. Returns the address to send the user to.
  */
  Cloud.billing = async function (action) {
    var result = await client.functions.invoke('billing', {
      body: { action: action, business: Cloud.business.id, returnTo: root.location.origin + root.location.pathname },
    });
    if (result.error) {
      var message = result.error.message || 'The payment page could not be opened.';
      try {
        var detail = await result.error.context.json();
        if (detail && detail.error) message = detail.error;
      } catch (ignore) { /* no detail given */ }
      throw new Error(message);
    }
    if (!result.data || !result.data.url) throw new Error('The payment page could not be opened.');
    return result.data.url;
  };

  // ---- products ----
  Cloud.products = async function () {
    if (Cloud.stacking === undefined) {
      var probe = await client.from('products').select('top_load_kg').limit(1);
      Cloud.stacking = !probe.error;
    }
    var rows = unwrap(await client.from('products').select('*').eq('business_id', Cloud.business.id).order('name'));
    return rows.map(fromRow);
  };

  /** Adds products; returns them as saved (with their ids). */
  Cloud.addProducts = async function (items, source) {
    if (!items.length) return [];
    var rows = items.map(function (item) {
      var row = toRow(item);
      row.business_id = Cloud.business.id;
      row.created_by = Cloud.user.id;
      row.source = source || 'manual';
      if (item.keepId) row.id = item.id;
      return row;
    });
    return unwrap(await client.from('products').insert(rows).select()).map(fromRow);
  };

  Cloud.updateProduct = async function (item) {
    unwrap(await client.from('products').update(toRow(item)).eq('id', item.id).eq('business_id', Cloud.business.id));
  };

  Cloud.deleteProduct = async function (id) {
    unwrap(await client.from('products').delete().eq('id', id).eq('business_id', Cloud.business.id));
  };

  // ---- people ----
  Cloud.team = async function () {
    var members = unwrap(await client.from('members').select('user_id, email, role, joined_at').eq('business_id', Cloud.business.id).order('joined_at'));
    var invitations = [];
    if (Cloud.isAdmin()) {
      invitations = unwrap(await client.from('invitations').select('id, email, role, created_at').eq('business_id', Cloud.business.id).order('created_at'));
    }
    return { members: members, invitations: invitations };
  };

  Cloud.invite = async function (email, role) {
    unwrap(await client.from('invitations').insert({
      business_id: Cloud.business.id, email: String(email).trim().toLowerCase(), role: role === 'admin' ? 'admin' : 'member', invited_by: Cloud.user.id,
    }));
  };

  Cloud.cancelInvitation = async function (id) {
    unwrap(await client.from('invitations').delete().eq('id', id));
  };

  Cloud.removeMember = async function (userId) {
    unwrap(await client.rpc('remove_member', { business: Cloud.business.id, person: userId }));
  };

  root.SPCloud = Cloud;
})(window);
