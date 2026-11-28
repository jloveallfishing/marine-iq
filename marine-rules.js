window.MarineRules = (() => {
  const release = '3.0.5';
  const fields = {
    minimum: 'Minimum size', maximum: 'Maximum size', bag: 'Daily bag limit',
    possession: 'Possession limit', season: 'Season', depth: 'Depth restrictions',
    methods: 'Permitted methods', permits: 'Licenses and permits', special: 'Special restrictions'
  };
  const bayPresets = new Set([0, 1, 3, 8, 9, 10]);
  const deltaPresets = new Set([6, 7, 11, 12]);
  const favoritesKey = 'marinecastFavoriteSpecies';
  const regionPreference = 'marinecastRulesRegion';

  function suggestRegion(trip) {
    if (trip.predefined) {
      if (bayPresets.has(trip.index)) return 'bay';
      if (deltaPresets.has(trip.index)) return 'delta';
      return '';
    }
    // Both place text and a broad sanity check are required. A map coordinate
    // alone cannot distinguish inland, tidal and ocean legal boundaries.
    if (trip.latitude >= 37.39 && trip.latitude <= 38.17 &&
        trip.longitude >= -122.48 && trip.longitude <= -122.13 &&
        /san francisco bay|san pablo bay|berkeley marina|richmond marina|angel island|alcatraz/i.test(trip.name)) return 'bay';
    if (trip.latitude >= 37.75 && trip.latitude <= 38.55 &&
        trip.longitude >= -122.1 && trip.longitude <= -121.25 &&
        /sacramento.san joaquin delta|rio vista|sherman island|delta marina|brannan island|three mile slough|seven mile slough/i.test(trip.name)) return 'delta';
    return '';
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function link(label, url) {
    const element = node('a', label);
    element.href = url;
    return element;
  }

  function dateLabel(date) {
    return date ? date.slice(5,7)+'/'+date.slice(8,10)+'/'+date.slice(0,4) : '';
  }

  function group(label, ...children) {
    const details = node('details', '', 'rule-group');
    details.append(node('summary',label),...children);
    return details;
  }

  function photoCredit(asset, tag, compact = false) {
    const credit = node(tag,'','rule-photo-credit');
    if (asset.label) credit.append(asset.label+' · ');
    const source = link(compact ? 'Credits' : asset.credit,asset.source);
    if (compact) source.setAttribute('aria-label',asset.credit);
    credit.append(source);
    if (!compact && asset.license) credit.append(' · ',link(asset.license[0],asset.license[1]));
    return credit;
  }

  const photoViewer = node('dialog','','rule-photo-viewer');
  photoViewer.setAttribute('aria-labelledby','rule-photo-title');
  const photoTitle = node('h2');
  photoTitle.id = 'rule-photo-title';
  const closePhoto = node('button','Close photo');
  closePhoto.type = 'button';
  closePhoto.addEventListener('click',()=>photoViewer.close());
  const photoBody = node('div');
  photoViewer.append(photoTitle,closePhoto,photoBody);
  let photoTrigger;
  photoViewer.addEventListener('close',()=>{
    photoBody.replaceChildren();
    photoTrigger?.focus();
    photoTrigger = null;
  });

  function showPhoto(asset, name, tip) {
    photoTitle.textContent = asset.label || name;
    const full = node('img');
    const unavailable = node('p','Photo unavailable.');
    unavailable.hidden = true;
    full.alt = asset.alt || name;
    full.referrerPolicy = 'no-referrer';
    full.addEventListener('error',()=>{
      full.hidden = true;
      unavailable.hidden = false;
    });
    full.src = asset.full || asset.url;
    photoBody.replaceChildren(full,unavailable,photoCredit(asset,'p'));
    if (tip) {
      const notes = node('p',tip.text);
      notes.append(' ',link('Identification guide',tip.source));
      photoBody.append(group('Identification tips',notes));
    }
    photoViewer.showModal();
  }

  function photo(asset, name, tip, inline = false) {
    const container = node(inline ? 'span' : 'figure','','rule-photo');
    const unavailable = node('span',asset?.url ? 'Photo unavailable' :
      [asset?.label,'Verified photo pending'].filter(Boolean).join(' · '),'rule-photo-missing');
    if (!asset?.url) {
      container.append(unavailable);
      return container;
    }
    const image = node('img');
    image.alt = asset.alt || name;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.src = asset.url;
    unavailable.hidden = true;
    const enlarge = node('button','','rule-photo-button');
    enlarge.type = 'button';
    enlarge.setAttribute('aria-label','Enlarge '+(asset.label || name)+' photo');
    enlarge.append(image);
    enlarge.addEventListener('click',event=>{
      event.preventDefault();
      photoTrigger = enlarge;
      showPhoto(asset,name,tip);
    });
    image.addEventListener('error',()=>{
      enlarge.hidden = true;
      unavailable.hidden = false;
    });
    container.append(enlarge,unavailable,photoCredit(asset,inline ? 'span' : 'figcaption',true));
    return container;
  }

  function groundfishContext(info, region, tripDate, today, method) {
    const current = info.regions.includes(region) && tripDate >= info.from && tripDate <= info.through &&
      today >= info.verified && today <= info.reviewBy;
    return {current, southernBoat:current && region === 'south' && method === 'boat'};
  }

  function addGroundfish(details, extra, info, data, region, method, context) {
    const {current,southernBoat} = context;
    if (current) {
      let season = 'Check local closures and the applicable depth boundary.';
      if (southernBoat) {
        season = 'October 1–December 31 · Nearshore rockfish, cabezon and greenlings: no boat retention. Shelf and slope rockfish: seaward of the 50-fathom boundary. Groundfish Exclusion Areas still apply.';
      } else if (method === 'shore') {
        season = 'Shore exemption · Year-round for otherwise eligible fish. A vessel cannot assist take, transport or possession.';
      } else if (method === 'dive') {
        season = 'Spearfishing exemption · Year-round for otherwise eligible fish. During boat closures, only spearfishing gear may be aboard under this exemption.';
      } else if (region === 'bay') {
        season = 'Bay waters refer to the San Francisco management table. Verify the applicable water and local boundary.';
      } else if (info.areas[region]) {
        season = 'April 1–December 31 · Published boat season at all depths, subject to local closures.';
      }
      details.append(node('p',season,'rule-retention'));
      if (method !== 'dive') details.append(node('p',method === 'boat'
        ? 'One line, two hooks maximum. Carry a descending device in ocean waters.'
        : 'One line, two hooks maximum when angling for these fish.','rule-retention'));
      else details.append(node('p','Have a descending device available when taking or possessing covered groundfish from a vessel in ocean waters.','rule-retention'));
    }
    const table = node('table','','groundfish-table');
    const header = node('tr');
    for (const name of ['Fish','Identification','Daily sublimit']) {
      const heading = node('th',name);
      heading.scope = 'col';
      header.append(heading);
    }
    const head = node('thead');
    head.append(header);
    const body = node('tbody');
    for (const fish of info.limits) {
      const limit = fish.limit ?? (region === 'north' ? fish.north : fish.other);
      const value = !current ? 'Unverified' :
        southernBoat && fish.class.startsWith('Nearshore') ? 'No boat retention' :
        limit ? limit + ' per person' : 'Combined limit';
      const row = node('tr');
      const title = node('th',fish.name);
      title.scope = 'row';
      if (fish.favorite) title.append(favoriteButton(fish.favorite,fish.name,context.favorites,true));
      const media = node('td');
      for (const item of fish.images || [fish.image]) media.append(photo(item,fish.name,data.identification[fish.name]));
      row.append(title,media,node('td',value));
      body.append(row);
    }
    table.append(head,body);
    details.append(node('h3','Individual species bag limits'),table);
    const prohibited = node('div','','rule-prohibited');
    prohibited.append(node('h3',current ? 'Prohibited retention' : '2026 reference · prohibited retention'));
    const grid = node('div','','groundfish-prohibited');
    for (const fish of info.prohibited) {
      const item = node('div');
      item.append(node('b',fish.name),photo(fish.image,fish.name,data.identification[fish.name]));
      grid.append(item);
    }
    prohibited.append(grid);
    details.append(prohibited);
    extra.append(
      node('p','Example: one retained copper rockfish leaves at most nine slots for other eligible fish.'),
      node('p','Transit exceptions are limited. Possession remains prohibited where a species is prohibited throughout the management area or exceeds its bag limit. Keep gear undeployed unless a specific exception applies.'),
      node('p','The federal waypoints define the 50-fathom (300-foot) boundary. A depth sounder alone cannot determine which side applies.'),
      link(...data.sources.groundfishBoundaries),
      node('p','Groundfish details verified '+dateLabel(info.verified)+' (Pacific).'));
    for (const id of ['rockfishID','copperID','noaaRockfishID','noaaBocaccioID']) {
      const row = node('p');
      row.append(link(...data.sources[id]));
      extra.append(row);
    }
  }

  function favoriteButton(id,name,favorites,small=false) {
    const favorite = node('button',favorites.has(id) ? '★' : '☆',small ? 'rule-row-star' : 'rule-star');
    favorite.type = 'button';
    favorite.dataset.species = id;
    favorite.setAttribute('aria-label','Favorite '+name);
    favorite.setAttribute('aria-pressed',String(favorites.has(id)));
    return favorite;
  }

  function ruleCard(species, entries, region, tripDate, today, data, favorites, method) {
    const details = node('details', '', 'rule-card');
    const summary = node('summary');
    summary.append(node('span',species.name,'rule-card-name'));
    details.append(summary);
    const extra = group('Additional Regulations');
    if (species.scientific) extra.append(node('p',species.scientific,'muted'));

    const regional = entries.filter(entry => entry.regions.includes(region));
    const inDate = entry => tripDate >= entry.from && tripDate <= entry.through &&
      today >= entry.verified && today <= entry.reviewBy;
    const current = regional.filter(inDate);
    const reference = regional.filter(entry => entry.kind === 'reference' && !inDate(entry));
    const restrictions = Object.assign({}, ...current.map(entry => entry.rules));
    const published = Object.assign({}, ...reference.map(entry => entry.rules));
    const groundfish = species.id === 'rockfish';
    const context = {...groundfishContext(data.groundfish,region,tripDate,today,method),favorites};
    const statuses = current.map(entry=>entry.status);
    let status = ['closed','retention','conditional','open'].find(key=>statuses.includes(key)) || 'unverified';
    if (groundfish) {
      status = !context.current ? 'unverified' :
        'conditional';
    }
    const labels = {closed:'Closed',retention:'No retention',conditional:'Conditional',open:'Season open',unverified:'Unverified'};
    summary.append(node('span',labels[status], 'rule-status rule-status-'+status));
    const ordinaryCount = value => value?.match(/^(\d+) (?:fish|crabs)(?: combined)?(?: under the (?:ordinary|standard) limit)?$/)?.[1];
    const limits = {...restrictions};
    if (groundfish) {
      limits.bag = context.current ? data.groundfish.combined + ' fish combined' : null;
      limits.minimum = context.current ? data.groundfish.minimum : null;
      limits.possession = null;
    }
    if (limits.bag === limits.possession || (ordinaryCount(limits.bag) && ordinaryCount(limits.bag) === ordinaryCount(limits.possession))) {
      limits.possession = null;
    }
    const metrics = node('span','','rule-quick-limits');
    for (const key of ['minimum','maximum','bag','possession']) {
      if (limits[key]) metrics.append(node('span',fields[key],'rule-quick-label'),node('strong',limits[key]));
    }
    if (metrics.childElementCount) summary.append(metrics);
    if (!groundfish) {
      const photos = node('span','','rule-photo-strip');
      for (const image of species.images || [species.image]) photos.append(photo(image,species.name,data.identification[species.id],true));
      summary.append(photos);
    }
    const tip = data.identification[species.id];
    if (tip) {
      const id = node('p',tip.text,'rule-identification');
      id.append(' ',link('Identification guide',tip.source));
      details.append(group('Identification tips',id));
    }
    if (groundfish) {
      if (context.current) details.append(node('p','Rockfish, cabezon and greenling all count toward the combined limit.','rule-retention'));
      addGroundfish(details,extra,data.groundfish,data,region,method,context);
    } else {
      for (const key of ['season','depth','special','methods']) {
        if (restrictions[key] && (key === 'season' || restrictions[key] !== restrictions.season)) {
          details.append(node('p',restrictions[key],'rule-retention'));
        }
      }
    }
    if ((status === 'unverified' || regional.some(entry=>entry.kind !== 'reference'&&!inDate(entry))) && regional.length) {
      details.append(node('p',reference.length ? 'Published reference available below. Fishing status is unverified.'
        : 'Some rules are unverified for this date or region. Check current official notices.','warn'));
    }
    if (restrictions.permits) extra.append(node('p',restrictions.permits));
    const historical = node('dl');
    for (const [key,label] of Object.entries(fields)) {
      if (published[key] && !restrictions[key]) historical.append(node('dt',label),node('dd',published[key]));
    }
    if (historical.childElementCount) extra.append(node('h3','Published reference · verify before use'),historical);
    const dates = new Set([...current,...reference].map(entry=>[
      entry.effective && 'Effective '+dateLabel(entry.effective),
      'Last verified '+dateLabel(entry.verified)
    ].filter(Boolean).join(' · ')));
    for (const date of dates) extra.append(node('p',date,'muted'));
    const sources = new Set([data.regions[region]?.source,...species.sources,
      ...regional.flatMap(entry=>entry.sources)].filter(Boolean));
    const links = node('ul','','rules-links');
    for (const id of sources) {
      const item = node('li');
      item.append(link(...data.sources[id]));
      links.append(item);
    }
    extra.append(node('h3','Official regulatory sources'),links);
    details.append(extra);
    const wrapper = node('section', '', 'rule-section');
    wrapper.append(favoriteButton(species.id,species.name,favorites),details);
    return wrapper;
  }

  function installComparisons(panel, data) {
    const {guides,groups,labels,species} = data.comparisons;
    const photos = new Map([...data.groundfish.limits,...data.groundfish.prohibited]
      .map(row=>[row.name,row.images || [row.image]]));
    const select = node('select');
    select.id = 'rule-comparison-group';
    const label = node('label','Rockfish group');
    label.htmlFor = select.id;
    const results = node('div','','rule-comparison-grid');
    const source = node('p','','muted');
    for (const id of Object.keys(groups)) select.append(new Option(labels[id],id));
    const references = node('ul','','rules-links');
    for (const [label,url] of Object.values(guides)) {
      const row = node('li');
      row.append(link(label,url));
      references.append(row);
    }
    panel.append(label,select,results,source,group('Identification guides',references));

    function render() {
      if (!panel.open) return;
      const guide = guides[select.value];
      results.replaceChildren(...groups[select.value].map(name=>{
        const entry = species[name];
        const card = node('article','','rule-comparison-species');
        const tip = {text:entry.tip,source:guide[1]};
        card.append(node('h3',name));
        const images = entry.images || photos.get(entry.groundfish) || [];
        if (!images.length) card.append(node('p','Verified photo pending','rule-photo-missing'));
        for (const asset of images) card.append(photo(asset,name+' rockfish',tip));
        card.append(node('p',entry.tip));
        return card;
      }));
      source.replaceChildren(link('Open the identification guide',guide[1]));
    }

    select.addEventListener('change',render);
    panel.addEventListener('toggle',()=>{
      if (panel.open && !results.childElementCount) render();
    });
    panel.hidden = false;
  }

  function install({getTrip, today}) {
    const page = document.getElementById('page-rules');
    page.append(photoViewer);
    const select = document.getElementById('rules-region');
    const search = document.getElementById('rules-search');
    const cards = document.getElementById('rules-cards');
    const method = document.getElementById('rules-method');
    const favoriteOnly = document.getElementById('rules-favorites');
    const ruleDate = document.getElementById('rules-date');
    const useToday = document.getElementById('rules-today');
    const tripDate = document.getElementById('rules-trip-date');
    let favorites = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(favoritesKey) || '[]');
      if (Array.isArray(saved)) favorites = new Set(saved);
    } catch {}
    const context = document.getElementById('rules-context');
    const tripLabel = document.getElementById('rules-trip');
    let data;
    let pending;
    let lastRender;
    let reviewDay;
    let salmonTab = 'ocean';
    let riverReach = '';

    function render() {
      if (page.hidden || !data) return;
      const trip = getTrip();
      const date = today();
      const suggested = suggestRegion(trip);
      const selectedDate = ruleDate.value || trip.date || date;
      const region = select.value === 'trip' ? suggested : select.value;
      const query = search.value.trim().toLowerCase();
      const key = JSON.stringify([trip, date, selectedDate, region, select.value, method.value, query, favoriteOnly.checked, [...favorites], salmonTab, riverReach]);
      if (key === lastRender) return;
      lastRender = key;
      tripLabel.textContent = `${trip.name || 'No fishing location'} · ${dateLabel(selectedDate)} (Pacific)`;
      const mismatch = Boolean(suggested && region !== suggested);
      context.classList.toggle('warn', mismatch);
      context.classList.toggle('rule-mismatch', mismatch);
      context.textContent = mismatch
        ? `Region mismatch. Showing ${data.regions[region].label}. The trip location suggests ${data.regions[suggested].label}. Confirm the official boundary.`
        : region ? `${select.value === 'trip' ? 'Suggested' : 'Selected'} region: ${data.regions[region].label}. Confirm the official boundary before fishing.`
        : 'Select a region manually for this location. A map pin alone does not establish jurisdiction.';
      document.getElementById('rules-snapshot').textContent =
        `Snapshot verified ${dateLabel(data.verified)} (Pacific). Check current official notices before fishing.`;
      const open = new Set([...cards.querySelectorAll('.rule-card[open]')].map(details => details.dataset.species));
      const matches = species => (!favoriteOnly.checked || favorites.has(species.id)) &&
        [species.name,species.scientific,...species.aliases].filter(Boolean).some(name=>name.toLowerCase().includes(query));
      const rows = data.species.filter(matches);
      const cardsFor = (species, entries, choice = region) => {
        const card = ruleCard(species,entries,choice,selectedDate,date,data,favorites,method.value);
        const details = card.querySelector('details');
        details.dataset.species = species.id;
        details.open = open.has(species.id);
        return card;
      };
      const sections = [];
      const groupIds = new Set(data.groundfish.species);
      const salmonIds = new Set(['chinook','coho']);
      let groundfishShown = false, salmonShown = false;
      for (const species of rows) {
        if (groupIds.has(species.id)) {
          if (!groundfishShown) {
            const entry = data.species.find(fish=>fish.id==='rockfish');
            sections.push(cardsFor(entry,data.entries.rockfish));
            groundfishShown = true;
          }
          continue;
        }
        if (!salmonIds.has(species.id)) {
          sections.push(cardsFor(species,data.entries[species.id] || []));
          continue;
        }
        if (salmonShown) continue;
        salmonShown = true;
        const section = node('section','','salmon-rules');
        section.append(node('h2','Salmon regulations'));
        const tabs = node('div','','salmon-tabs');
        tabs.setAttribute('role','tablist');
        tabs.setAttribute('aria-label','Salmon waters');
        for (const [key,name] of [['ocean','Ocean Salmon'],['river','River Salmon']]) {
          const tab = node('button',name);
          tab.type = 'button';
          tab.id = 'salmon-tab-'+key;
          tab.setAttribute('role','tab');
          tab.setAttribute('aria-selected',String(salmonTab===key));
          tab.setAttribute('aria-controls','salmon-rules-panel');
          tab.tabIndex = salmonTab===key ? 0 : -1;
          function selectTab(next) {
            salmonTab = next;
            render();
            document.getElementById('salmon-tab-'+next)?.focus();
          }
          tab.onclick = ()=>selectTab(key);
          tab.onkeydown = event=>{
            if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
              event.preventDefault();
              selectTab(event.key==='Home' ? 'ocean' : event.key==='End' ? 'river' : key==='ocean' ? 'river' : 'ocean');
            }
          };
          tabs.append(tab);
        }
        const panel = node('div');
        panel.id='salmon-rules-panel';
        panel.setAttribute('role','tabpanel');
        panel.setAttribute('aria-labelledby','salmon-tab-'+salmonTab);
        if (salmonTab==='river') {
          const label = node('label','River section');
          label.htmlFor='salmon-reach';
          const reaches=node('select');
          reaches.id='salmon-reach';
          reaches.append(new Option('Choose an exact river section',''));
          for (const [id,reach] of Object.entries(data.salmon.rivers)) reaches.append(new Option(reach.label,id));
          reaches.value=riverReach;
          reaches.onchange=()=>{
            riverReach=reaches.value;
            render();
            document.getElementById('salmon-reach')?.focus();
          };
          panel.append(label,reaches);
          if (!riverReach) panel.append(node('p','Choose the reach for Chinook limits. For other reaches, use the inland regulations.','warn'));
          panel.append(link(...data.sources.inlandSalmon));
        } else if (!data.salmon.oceanAreas[region]) {
          panel.append(node('p','Choose a California ocean region to display its rules.','warn'));
        } else panel.append(node('p',data.salmon.oceanAreas[region],'muted'));
        for (const fish of data.species.filter(f=>salmonIds.has(f.id)&&(!favoriteOnly.checked||favorites.has(f.id)))) {
          const reach = data.salmon.rivers[riverReach];
          const inland = salmonTab==='river';
          const choice = inland ? 'river' : region;
          const entries = inland ? (fish.id==='chinook' ? reach?.entries || [] : data.salmon.riverCoho) : data.entries[fish.id];
          const image = (inland && fish.riverImage) || fish.image;
          const sources = inland ? ['inlandSalmon','inlandEmergency'] : fish.sources;
          panel.append(cardsFor({...fish,image,sources},entries,choice));
        }
        section.append(tabs,panel);
        sections.push(section);
      }
      cards.replaceChildren(...sections);
      if (!rows.length) cards.append(node('p', favoriteOnly.checked ? 'No favorite species match.' : 'No matching species. Check the official regional regulations.'));
    }

    function refresh() {
      if (page.hidden) return;
      if (data) { render(); return; }
      if (pending) return;
      cards.setAttribute('aria-busy', 'true');
      cards.textContent = 'Loading regulations…';
      pending = fetch('./fishing-rules.json?v=305').then(response => {
        if (!response.ok) throw Error('Rules download failed');
        return response.json();
      }).then(snapshot => {
        if (snapshot.release !== release) throw Error('Rules are from a different release');
        for (const [label, ids] of [
          ['Bay and inland', ['bay','delta','inland']],
          ['Pacific coast', ['north','mendocino','sf','central','south']]
        ]) {
          const group = node('optgroup');
          group.label = label;
          for (const id of ids) group.append(new Option(snapshot.regions[id].label, id));
          select.append(group);
        }
        try {
          const saved = localStorage.getItem(regionPreference);
          if (Object.hasOwn(snapshot.regions, saved)) select.value = saved;
        } catch {}
        data = snapshot;
        installComparisons(document.getElementById('rule-comparisons'),data);
        render();
      }).catch(() => {
        cards.textContent = 'Regulations unavailable. Use the official links above.';
        const retry = node('button', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', refresh);
        cards.append(retry);
      }).finally(() => {
        pending = null;
        cards.setAttribute('aria-busy', 'false');
      });
    }

    select.addEventListener('change', () => {
      try { localStorage.setItem(regionPreference, select.value); } catch {}
      render();
    });
    search.addEventListener('input', render);
    method.addEventListener('change',render);
    ruleDate.addEventListener('change', render);
    useToday.addEventListener('click', () => { ruleDate.value = today(); render(); });
    tripDate.addEventListener('click', () => { ruleDate.value = ''; render(); });
    favoriteOnly.addEventListener('change', render);
    cards.addEventListener('click', event => {
      const button = event.target.closest('button[data-species]');
      if (!button) return;
      const id = button.dataset.species;
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      try { localStorage.setItem(favoritesKey, JSON.stringify([...favorites])); } catch {}
      if (favoriteOnly.checked && !favorites.has(id)) {
        render();
        favoriteOnly.focus();
      } else {
        button.textContent = favorites.has(id) ? '★' : '☆';
        button.setAttribute('aria-pressed', String(favorites.has(id)));
      }
    });
    new MutationObserver(refresh).observe(page, {attributes: true, attributeFilter: ['hidden']});
    new MutationObserver(render).observe(document.getElementById('pagecontext'), {childList: true});
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => {
      if (!page.hidden && data && reviewDay !== today()) {
        reviewDay = today();
        render();
      }
    }, 60000);
    refresh();
  }
  return {install};
})();
