// Shared app state, filled once at boot by app.js
export const state = {
  user: null,       // Supabase auth user
  profile: null,    // row from profiles
  myRoles: [],      // ['cold_caller', ...]
  roles: [],        // team_roles rows
  settings: null,   // app_settings row
  isAdmin: false,
};
export const roleName = (key) => state.roles.find((r) => r.key === key)?.name || key;
