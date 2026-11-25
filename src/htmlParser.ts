import type {
  ParsedAnchor,
  ParsedCheckbox,
  ParsedControl,
  ParsedForm,
  ParsedHtmlDocument,
} from './types.js';

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  sect: '§',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
};

export function decodeHtmlEntities(input: string): string {
  if (!input || !input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    return NAMED_HTML_ENTITIES[entity] ?? full;
  });
}

function getAttr(attrString: string, attrName: string): string {
  if (!attrString) return '';
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
    'i',
  );
  const match = regex.exec(attrString);
  if (!match) return '';
  const raw = match[1] ?? match[2] ?? match[3] ?? '';
  return decodeHtmlEntities(raw).trim();
}

function hasBooleanAttr(attrString: string, attrName: string): boolean {
  if (!attrString) return false;
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\s)${escaped}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+)))?(?=\\s|$|\\/)`,
    'i',
  );
  const match = re.exec(attrString);
  if (!match) return false;
  const explicitVal = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
  if (explicitVal === 'false' || explicitVal === '0' || explicitVal === 'no') {
    return false;
  }
  return true;
}

function extractDataAttributesSummary(attrString: string): string {
  if (!attrString) return '';
  const matches: string[] = [];
  const re = /\b(data-[a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    const key = m[1].toLowerCase();
    const val = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '').slice(0, 80);
    matches.push(val ? `${key}="${val}"` : key);
    if (matches.length >= 10) break;
  }
  return matches.join(' ');
}

function stripTagsPreserveAlt(htmlFragment: string): string {
  if (!htmlFragment) return '';
  const withImgAlt = htmlFragment.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const alt = getAttr(attrs, 'alt');
    return alt ? ` ${alt} ` : ' ';
  });
  const withoutTags = withImgAlt.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function safeResolveUrl(rawHref: string, baseUrl: string): string {
  const trimmed = rawHref.trim();
  if (!trimmed) return '';
  if (/^(?:javascript|mailto|tel|data):/i.test(trimmed)) {
    return trimmed;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function findRegionRanges(html: string, tagName: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (ranges.length >= 25) break;
  }
  return ranges;
}

function isIndexInRanges(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (idx >= start && idx <= end) return true;
  }
  return false;
}

const SURVEY_FIELD_SIGNAL_RE =
  /\b(cancel[-_ ]?reason|cancellation[-_ ]?reason|reason[-_ ]?for[-_ ]?(?:cancel|cancell?ing|leaving)|why[-_ ]?(?:cancel|cancell?ing|are[-_ ]?you[-_ ]?leaving|leaving)|exit[-_ ]?(?:survey|interview|questionnaire)|retention[-_ ]?(?:survey|reason)|cancell?ation[-_ ]?(?:survey|feedback|questionnaire)|\bsurvey\b|\bfeedback\b|\breason\b)\b/i;

export function parseHtmlDocument(rawHtml: string, pageUrl: string): ParsedHtmlDocument {
  const html = rawHtml || '';

  // 1. Remove HTML comments first
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, ' ');

  // 2. <html lang="..."> & <title>
  let htmlLang: string | null = null;
  const htmlTagMatch = /<html\b([^>]*)>/i.exec(uncommented);
  if (htmlTagMatch) {
    const rawLang = getAttr(htmlTagMatch[1], 'lang');
    if (rawLang) {
      htmlLang = rawLang.split(/[-_]/)[0].toLowerCase();
    }
  }

  let title: string | null = null;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(uncommented);
  if (titleMatch) {
    const cleanTitle = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    title = cleanTitle || null;
  }

  // 3. Extract <script> URLs, inline scripts, and JSON-LD blocks before stripping scripts
  const scriptUrls: string[] = [];
  const inlineScripts: string[] = [];
  const jsonLdBlocks: unknown[] = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRe.exec(uncommented)) !== null) {
    const attrs = scriptMatch[1] || '';
    const body = (scriptMatch[2] || '').trim();
    const src = getAttr(attrs, 'src');
    const type = getAttr(attrs, 'type').toLowerCase();

    if (src && scriptUrls.length < 150) {
      scriptUrls.push(safeResolveUrl(src, pageUrl));
    }
    if (type === 'application/ld+json' && body && jsonLdBlocks.length < 25) {
      try {
        jsonLdBlocks.push(JSON.parse(body));
      } catch {
        // Ignore invalid JSON-LD blocks
      }
    } else if (!src && body && inlineScripts.length < 40) {
      inlineScripts.push(body.slice(0, 6_000));
    }
  }

  // 4. Extract <link> stylesheet/resource URLs
  const stylesheetUrls: string[] = [];
  const linkRe = /<link\b([^>]*)>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRe.exec(uncommented)) !== null) {
    const href = getAttr(linkMatch[1], 'href');
    if (href && stylesheetUrls.length < 100) {
      stylesheetUrls.push(safeResolveUrl(href, pageUrl));
    }
  }

  // 5. Strip <script> and <style> for structural DOM inspection
  const domHtml = uncommented
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  const footerRanges = findRegionRanges(domHtml, 'footer');
  const navRanges = [
    ...findRegionRanges(domHtml, 'nav'),
    ...findRegionRanges(domHtml, 'header'),
  ];

  // Build <label for="..."> map for accurate checkbox & survey control labeling
  const labelByForId = new Map<string, string>();
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let lblMatch: RegExpExecArray | null;
  while ((lblMatch = labelRe.exec(domHtml)) !== null) {
    const forId = getAttr(lblMatch[1] || '', 'for');
    if (forId && !labelByForId.has(forId)) {
      labelByForId.set(forId, stripTagsPreserveAlt(lblMatch[2] || '').slice(0, 320));
    }
  }

  // 6. Extract <a ...>...</a> anchors
  const anchors: ParsedAnchor[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRe.exec(domHtml)) !== null) {
    if (anchors.length >= 500) break;
    const attrs = anchorMatch[1] || '';
    const inner = anchorMatch[2] || '';
    const href = getAttr(attrs, 'href');
    const resolvedHref = href ? safeResolveUrl(href, pageUrl) : '';
    const text = stripTagsPreserveAlt(inner).slice(0, 240);
    const ariaLabel = getAttr(attrs, 'aria-label').slice(0, 200);
    const anchorTitle = getAttr(attrs, 'title').slice(0, 200);
    const id = getAttr(attrs, 'id');
    const className = getAttr(attrs, 'class');

    anchors.push({
      href,
      resolvedHref,
      text,
      ariaLabel,
      title: anchorTitle,
      id,
      className,
      inFooter: isIndexInRanges(anchorMatch.index, footerRanges),
      inNav: isIndexInRanges(anchorMatch.index, navRanges),
    });
  }

  // 7. Extract interactive <button>, <input type="submit|button">, and [role="button"] controls,
  //    PLUS <input type="checkbox"> and [role="checkbox"] elements for ROSCA / CA AB 2863 consent audit
  const controls: ParsedControl[] = [];
  const checkboxes: ParsedCheckbox[] = [];

  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let btnMatch: RegExpExecArray | null;
  while ((btnMatch = buttonRe.exec(domHtml)) !== null) {
    if (controls.length >= 250) break;
    const attrs = btnMatch[1] || '';
    controls.push({
      tag: 'button',
      type: getAttr(attrs, 'type').toLowerCase() || 'submit',
      text: stripTagsPreserveAlt(btnMatch[2] || '').slice(0, 240),
      ariaLabel: getAttr(attrs, 'aria-label').slice(0, 200),
      id: getAttr(attrs, 'id'),
      className: getAttr(attrs, 'class'),
      name: getAttr(attrs, 'name'),
      dataAttributes: extractDataAttributesSummary(attrs),
    });
  }

  const inputTagRe = /<input\b([^>]*)>/gi;
  let inpMatch: RegExpExecArray | null;
  while ((inpMatch = inputTagRe.exec(domHtml)) !== null) {
    const attrs = inpMatch[1] || '';
    const inpType = (getAttr(attrs, 'type') || 'text').toLowerCase();

    if ((inpType === 'submit' || inpType === 'button') && controls.length < 300) {
      controls.push({
        tag: 'input',
        type: inpType,
        text: getAttr(attrs, 'value').slice(0, 240),
        ariaLabel: getAttr(attrs, 'aria-label').slice(0, 200),
        id: getAttr(attrs, 'id'),
        className: getAttr(attrs, 'class'),
        name: getAttr(attrs, 'name'),
        dataAttributes: extractDataAttributesSummary(attrs),
      });
    } else if (inpType === 'checkbox' && checkboxes.length < 100) {
      const id = getAttr(attrs, 'id');
      const name = getAttr(attrs, 'name');
      const className = getAttr(attrs, 'class');
      const value = getAttr(attrs, 'value');
      const ariaLabel = getAttr(attrs, 'aria-label');
      const checked =
        hasBooleanAttr(attrs, 'checked') ||
        hasBooleanAttr(attrs, 'defaultChecked') ||
        getAttr(attrs, 'aria-checked').toLowerCase() === 'true';
      const required =
        hasBooleanAttr(attrs, 'required') ||
        getAttr(attrs, 'aria-required').toLowerCase() === 'true';

      const explicitLabel = id ? labelByForId.get(id) ?? '' : '';
      const windowStart = Math.max(0, inpMatch.index - 140);
      const windowEnd = Math.min(domHtml.length, inpMatch.index + inpMatch[0].length + 340);
      const nearbyText = stripTagsPreserveAlt(domHtml.slice(windowStart, windowEnd)).slice(0, 360);
      const associatedText = `${explicitLabel} ${ariaLabel} ${nearbyText}`.replace(/\s+/g, ' ').trim();

      checkboxes.push({
        id,
        name,
        className,
        value,
        checked,
        required,
        associatedText,
      });
    }
  }

  const roleCheckboxRe =
    /<(?:div|span|button)\b([^>]*\brole\s*=\s*["']checkbox["'][^>]*)>([\s\S]*?)<\/(?:div|span|button)>/gi;
  let rcMatch: RegExpExecArray | null;
  while ((rcMatch = roleCheckboxRe.exec(domHtml)) !== null) {
    if (checkboxes.length >= 120) break;
    const attrs = rcMatch[1] || '';
    const id = getAttr(attrs, 'id');
    const checked = getAttr(attrs, 'aria-checked').toLowerCase() === 'true';
    const required = getAttr(attrs, 'aria-required').toLowerCase() === 'true';
    const innerText = stripTagsPreserveAlt(rcMatch[2] || '');
    const windowStart = Math.max(0, rcMatch.index - 100);
    const windowEnd = Math.min(domHtml.length, rcMatch.index + rcMatch[0].length + 280);
    const nearbyText = stripTagsPreserveAlt(domHtml.slice(windowStart, windowEnd)).slice(0, 320);

    checkboxes.push({
      id,
      name: getAttr(attrs, 'name'),
      className: getAttr(attrs, 'class'),
      value: '',
      checked,
      required,
      associatedText: `${id ? labelByForId.get(id) ?? '' : ''} ${getAttr(attrs, 'aria-label')} ${innerText} ${nearbyText}`
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }

  const roleBtnRe =
    /<(?:div|span|label|summary)\b([^>]*\brole\s*=\s*["']button["'][^>]*)>([\s\S]*?)<\/(?:div|span|label|summary)>/gi;
  let roleMatch: RegExpExecArray | null;
  while ((roleMatch = roleBtnRe.exec(domHtml)) !== null) {
    if (controls.length >= 350) break;
    const attrs = roleMatch[1] || '';
    controls.push({
      tag: 'role-button',
      type: 'button',
      text: stripTagsPreserveAlt(roleMatch[2] || '').slice(0, 240),
      ariaLabel: getAttr(attrs, 'aria-label').slice(0, 200),
      id: getAttr(attrs, 'id'),
      className: getAttr(attrs, 'class'),
      name: getAttr(attrs, 'name'),
      dataAttributes: extractDataAttributesSummary(attrs),
    });
  }

  // 8. Extract required survey controls across the document + inside <form> elements
  const requiredSurveyControls: string[] = [];
  const inspectFieldForSurveyRequirement = (tag: string, fAttrs: string): string | null => {
    const fType = (getAttr(fAttrs, 'type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    if (
      fType === 'hidden' ||
      fType === 'submit' ||
      fType === 'button' ||
      fType === 'email' ||
      fType === 'password' ||
      fType === 'checkbox'
    ) {
      return null;
    }
    const isReq =
      hasBooleanAttr(fAttrs, 'required') ||
      getAttr(fAttrs, 'aria-required').toLowerCase() === 'true';
    if (!isReq) return null;

    const fName = getAttr(fAttrs, 'name');
    const fId = getAttr(fAttrs, 'id');
    const fPlaceholder = getAttr(fAttrs, 'placeholder');
    const fAria = getAttr(fAttrs, 'aria-label');
    const fLabel = fId ? labelByForId.get(fId) ?? '' : '';
    const combined = `${fName} ${fId} ${fPlaceholder} ${fAria} ${fLabel}`;

    // Skip optional-labeled fields if any, and require explicit survey/reason semantics
    if (/\boptional\b/i.test(fLabel) && !hasBooleanAttr(fAttrs, 'required')) {
      return null;
    }
    if (SURVEY_FIELD_SIGNAL_RE.test(combined)) {
      const ident = fName || fId || fAria || 'survey_field';
      return `<${tag} name="${ident}" required>`;
    }
    return null;
  };

  const docFieldRe = /<(input|select|textarea)\b([^>]*)>/gi;
  let dfm: RegExpExecArray | null;
  while ((dfm = docFieldRe.exec(domHtml)) !== null) {
    const hit = inspectFieldForSurveyRequirement(dfm[1].toLowerCase(), dfm[2] || '');
    if (hit && !requiredSurveyControls.includes(hit) && requiredSurveyControls.length < 20) {
      requiredSurveyControls.push(hit);
    }
  }

  // 9. Extract <form> elements
  const forms: ParsedForm[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch: RegExpExecArray | null;
  while ((formMatch = formRe.exec(domHtml)) !== null) {
    if (forms.length >= 50) break;
    const attrs = formMatch[1] || '';
    const inner = formMatch[2] || '';
    const action = getAttr(attrs, 'action');
    const resolvedAction = action ? safeResolveUrl(action, pageUrl) : pageUrl;
    const method = (getAttr(attrs, 'method') || 'get').toLowerCase();
    const id = getAttr(attrs, 'id');
    const className = getAttr(attrs, 'class');

    const inputNamesAndTypes: string[] = [];
    const requiredSurveyFields: string[] = [];
    let hasPasswordInput = false;
    let hasEmailOrOrderInput = false;

    const fieldRe = /<(input|select|textarea)\b([^>]*)>/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(inner)) !== null) {
      const tag = fm[1].toLowerCase();
      const fAttrs = fm[2] || '';
      const fType = (getAttr(fAttrs, 'type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
      const fName = getAttr(fAttrs, 'name');
      const fId = getAttr(fAttrs, 'id');
      const fPlaceholder = getAttr(fAttrs, 'placeholder');
      const combined = `${fName} ${fId} ${fPlaceholder}`.toLowerCase();

      if (fType === 'password') {
        hasPasswordInput = true;
      }
      if (
        fType === 'email' ||
        /\b(email|e-mail|mail|order|subscription|account|member|number|ref)\b/i.test(combined)
      ) {
        hasEmailOrOrderInput = true;
      }
      inputNamesAndTypes.push(`${fName || fId || 'field'}:${fType}`);

      const surveyHit = inspectFieldForSurveyRequirement(tag, fAttrs);
      if (surveyHit && !requiredSurveyFields.includes(surveyHit)) {
        requiredSurveyFields.push(surveyHit);
      }
    }

    const buttonTexts: string[] = [];
    const innerBtnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let ibm: RegExpExecArray | null;
    while ((ibm = innerBtnRe.exec(inner)) !== null) {
      const t = stripTagsPreserveAlt(ibm[2] || '') || getAttr(ibm[1] || '', 'aria-label');
      if (t) buttonTexts.push(t.slice(0, 160));
    }
    const innerSubRe = /<input\b([^>]*)>/gi;
    let ism: RegExpExecArray | null;
    while ((ism = innerSubRe.exec(inner)) !== null) {
      const tType = getAttr(ism[1] || '', 'type').toLowerCase();
      if (tType === 'submit' || tType === 'button') {
        const val = getAttr(ism[1] || '', 'value');
        if (val) buttonTexts.push(val.slice(0, 160));
      }
    }

    forms.push({
      action,
      resolvedAction,
      method,
      id,
      className,
      inputNamesAndTypes,
      requiredSurveyFields,
      hasPasswordInput,
      hasEmailOrOrderInput,
      buttonTexts,
      textSnippet: stripTagsPreserveAlt(inner).slice(0, 500),
    });
  }

  // 10. Clean visible text (strip remaining SVG bodies, keep img[alt])
  const withoutSvg = domHtml.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  const visibleText = stripTagsPreserveAlt(withoutSvg);

  return {
    url: pageUrl,
    title,
    htmlLang,
    rawHtml: html,
    visibleText,
    scriptUrls,
    inlineScripts,
    stylesheetUrls,
    jsonLdBlocks,
    anchors,
    controls,
    checkboxes,
    requiredSurveyControls,
    forms,
  };
}
