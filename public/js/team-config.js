// Ecometrix Hub departments, designations and founding team (used on the Team page)
export const FOUNDER_TITLE = 'Co-Founder';

export const DEPARTMENTS = [
  { name: 'Business Development (Field)', points: 'Local market visits and lead generation, client meetings and in-person pitches, offline client relationships and renewals' },
  { name: 'Digital Marketing & Client Accounts & Finance', points: 'Socials for Ecometrix and clients, client communication and reports, invoices, payments, expenses and P&L' },
  { name: 'Growth & Sales (Online)', points: 'Online lead generation and outreach (UK, USA, Pakistan), discovery calls, proposals and closing, marketing and ads strategy' },
  { name: 'Tech & Operations', points: 'Shopify and WordPress websites, tracking (GA4, GTM, Meta CAPI), CRO, internal systems, automations and operations' },
];

// The four co-founders. They get the Manager role (admin-level access) and lead one department each.
export const FOUNDERS = [
  { first_name: 'Maliha', last_name: 'Khan', email: 'khanmaliha99909@gmail.com', department: 'Digital Marketing & Client Accounts & Finance' },
  { first_name: 'Haseeb', last_name: 'Gul', email: 'haseebg0012@gmail.com', department: 'Tech & Operations' },
  { first_name: 'Taha', last_name: 'Khan', email: 'tk9715495@gmail.com', department: 'Growth & Sales (Online)' },
  { first_name: 'Tahir', last_name: 'Khan', email: 'tk247454@gmail.com', department: 'Business Development (Field)' },
];

// Designations for everyone else (A–Z). Founding positions are not in this list.
export const DESIGNATIONS = [
  'Ads Specialist',
  'Cold Caller',
  'Content Writer',
  'Creatives & Posting Agent',
  'Finance Executive',
  'Graphic Designer',
  'Intern',
  'Lead Generation Agent',
  'Outreach Agent',
  'Project Manager',
  'Sales Representative',
  'SEO Specialist',
  'Social Media Manager',
  'UI/UX Designer',
  'Video Editor',
  'Web Developer',
].sort((a, b) => a.localeCompare(b));

// Designations that do project work (shown when a project manager picks who to add)
export const PROJECT_ROLES = DESIGNATIONS.filter((d) => !['Project Manager', 'Sales Representative', 'Lead Generation Agent', 'Outreach Agent', 'Cold Caller', 'Finance Executive'].includes(d));
