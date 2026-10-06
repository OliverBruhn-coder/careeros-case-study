'use strict';

const DIMENSION_WEIGHTS = require('./scoring_weights.json');

const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

const TERM_VARIANTS = {
  'data analyst': ['data analyst', 'dataanalytiker', 'analytiker'],
  'business analyst': ['business analyst', 'forretningsanalytiker'],
  'business intelligence': ['business intelligence', 'bi', 'rapportering', 'dashboard'],
  'pricing analyst': ['pricing analyst', 'pricing', 'prisanalytiker', 'prissætning'],
  'commercial analyst': ['commercial analyst', 'kommerciel analytiker', 'forretningsanalyse'],
  'graduate consultant': ['graduate consultant', 'graduate', 'konsulent', 'rådgiver'],
  'operations analyst': ['operations analyst', 'operationsanalytiker', 'driftsanalyse'],
  'studentermedhjælper': ['studentermedhjælper', 'student assistant', 'studieassistent'],
  'studiejob': ['studiejob', 'student job', 'studenterJob'],
  'junior analyst': ['junior analyst', 'junior analytiker', 'junior data analyst'],
};

const PART_TIME_PATTERNS = [
  /\bdeltid\b/i,
  /\bpart.time\b/i,
  /\bstudiejob\b/i,
  /\bstudentermedhjælper\b/i,
  /\bstudent\s+assistant\b/i,
  /\b15.20\s+timer\b/i,
  /\b20.30\s+timer\b/i,
  /\btimer\s+om\s+ugen\b/i,
  /\bfleksible\s+arbejdstider\b/i,
  /\bved\s+siden\s+af\s+studie\b/i,
];

const isPartTimePosting = (text) => PART_TIME_PATTERNS.some((p) => p.test(text));

const keywordVariants = (value) => TERM_VARIANTS[normalizeText(value)] || [normalizeText(value)];

const includesKeyword = (haystack, needle) =>
  keywordVariants(needle).some((variant) => variant && ` ${haystack} `.includes(` ${variant} `));

const DIMENSION_META = {
  skill_match: {
    label: 'Skill match',
    explanation: 'How many required skills are supported by verified profile evidence.',
  },
  title_alignment: {
    label: 'Title alignment',
    explanation: 'How closely the role title matches target titles in the search profile.',
  },
  location_fit: {
    label: 'Location fit',
    explanation: 'Whether the role location matches preferred locations or is unspecified/flexible.',
  },
  seniority_match: {
    label: 'Seniority match',
    explanation: 'Whether the posting avoids seniority or experience signals outside the target range.',
  },
  role_clarity: {
    label: 'Role clarity',
    explanation: 'How much concrete responsibility and requirement detail was captured.',
  },
  company_signals: {
    label: 'Company signals',
    explanation: 'Whether the posting gives useful growth, benefit, training, or team signals.',
  },
  work_type_fit: {
    label: 'Work type fit',
    explanation: 'Whether the posting work type (deltid/studiejob/fuldtid) matches the candidate preference.',
  },
};

const buildScoreDimensions = (dimensionScores = {}, evidence = {}) =>
  Object.entries(DIMENSION_META).map(([key, meta]) => ({
    key,
    label: meta.label,
    score: Number.isFinite(Number(dimensionScores[key])) ? Number(dimensionScores[key]) : 0,
    explanation: meta.explanation,
    evidence: evidence[key] || '',
  }));

const buildDimensionScore = (truthReport, jobEntry, searchProfile) => {
  const supported = truthReport.summary?.supported_count || 0;
  const adjacent = truthReport.summary?.adjacent_count || 0;
  const unsupported = truthReport.summary?.unsupported_count || 0;
  const total = supported + adjacent + unsupported;
  const skillMatch = total > 0 ? Math.round((supported / total) * 10) : 5;

  const title = normalizeText(jobEntry.title);
  const titleHits = (searchProfile.target_titles || []).filter((t) => includesKeyword(title, t)).length;
  const titleAlignment = Math.min(10, titleHits * 5);

  const location = normalizeText(jobEntry.location);
  const locationHit = location && (searchProfile.preferred_locations || []).some((l) => location.includes(normalizeText(l)));
  const locationFit = locationHit ? 10 : (location ? 2 : 5);

  const reqText = normalizeText([jobEntry.title, ...(jobEntry.sections?.requirements || [])].join(' '));
  const negativeHits = (searchProfile.negative_keywords || []).filter((n) => reqText.includes(normalizeText(n))).length;
  const seniorityMatch = negativeHits === 0 ? 10 : Math.max(0, 10 - negativeHits * 4);

  const reqCount = (jobEntry.sections?.requirements || []).filter((r) => r && r !== 'n/a').length;
  const aboutLen = (jobEntry.sections?.about_role || '').trim().length;
  const roleClarity = reqCount >= 5 ? 10 : reqCount >= 3 ? 7 : reqCount >= 1 ? 5 : (aboutLen >= 200 ? 4 : 2);

  const weOffer = normalizeText((jobEntry.sections?.we_offer || []).join(' '));
  const hasGrowth = /learn|grow|develop|career|progress|mentor|training/.test(weOffer);
  const hasBenefits = /salary|wage|pension|lunch|flex|bonus|paid|insuran/.test(weOffer) || (jobEntry.sections?.we_offer || []).length >= 2;
  const companySignals = (hasGrowth ? 5 : 0) + (hasBenefits ? 5 : 0);

  // Work type fit: bonus if posting matches candidate's work_type_preference
  const workTypePref = searchProfile.work_type_preference || [];
  const fullPostingText = [
    jobEntry.title,
    jobEntry.sections?.about_role || '',
    ...(jobEntry.sections?.requirements || []),
    ...(jobEntry.sections?.we_offer || []),
  ].join(' ');
  const postingIsPartTime = isPartTimePosting(fullPostingText);
  const candidateWantsDeltid = workTypePref.some((w) => /deltid|studiejob/.test(normalizeText(w)));
  let workTypeFit = 5; // neutral default
  let workTypeEvidence = 'No explicit work-type signal detected.';
  if (postingIsPartTime && candidateWantsDeltid) {
    workTypeFit = 10;
    workTypeEvidence = 'Part-time/studiejob posting matches candidate preference.';
  } else if (!postingIsPartTime && !candidateWantsDeltid) {
    workTypeFit = 7;
    workTypeEvidence = 'Full-time posting, candidate open to full-time.';
  } else if (postingIsPartTime && !candidateWantsDeltid) {
    workTypeFit = 6;
    workTypeEvidence = 'Part-time posting, candidate has no explicit part-time preference set.';
  }

  const dimensionScores = {
    skill_match: skillMatch,
    title_alignment: titleAlignment,
    location_fit: locationFit,
    seniority_match: seniorityMatch,
    role_clarity: roleClarity,
    company_signals: companySignals,
    work_type_fit: workTypeFit,
  };

  const scoreDimensions = buildScoreDimensions(dimensionScores, {
    skill_match: `${supported} verified, ${adjacent} adjacent, ${unsupported} unsupported skill signals.`,
    title_alignment: titleHits > 0 ? `${titleHits} target title match(es) found.` : 'No direct target-title match in the role title.',
    location_fit: location ? (locationHit ? `Location matches preference: ${jobEntry.location}.` : `Location captured as ${jobEntry.location}, not a preferred-location match.`) : 'No concrete location captured.',
    seniority_match: negativeHits === 0 ? 'No negative seniority keywords detected.' : `${negativeHits} negative seniority keyword(s) detected.`,
    role_clarity: `${reqCount} requirement item(s), about-role text length ${aboutLen}.`,
    company_signals: companySignals > 0 ? 'Growth or benefit signals detected in the posting.' : 'No clear growth or benefit signals captured.',
    work_type_fit: workTypeEvidence,
  });

  const dimensionWeightedScore = Math.round(
    skillMatch * DIMENSION_WEIGHTS.skill_match
    + titleAlignment * DIMENSION_WEIGHTS.title_alignment
    + locationFit * DIMENSION_WEIGHTS.location_fit
    + seniorityMatch * DIMENSION_WEIGHTS.seniority_match
    + roleClarity * DIMENSION_WEIGHTS.role_clarity
    + companySignals * DIMENSION_WEIGHTS.company_signals
    + workTypeFit * DIMENSION_WEIGHTS.work_type_fit,
  );

  const jobGrade = dimensionWeightedScore >= 90 ? 'A'
    : dimensionWeightedScore >= 75 ? 'B'
    : dimensionWeightedScore >= 58 ? 'C'
    : dimensionWeightedScore >= 42 ? 'D'
    : 'F';

  return {
    job_grade: jobGrade,
    dimension_scores: dimensionScores,
    score_dimensions: scoreDimensions,
    dimension_weighted_score: dimensionWeightedScore,
  };
};

module.exports = { buildDimensionScore, buildScoreDimensions, isPartTimePosting, DIMENSION_WEIGHTS };
