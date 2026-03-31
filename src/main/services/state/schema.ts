export const INITIAL_SCHEMA_SQL = `
create table if not exists canvas_views (
  id text primary key,
  name text not null,
  view_kind text not null check (view_kind in ('session_tree', 'workspace')),
  viewport_x real not null,
  viewport_y real not null,
  zoom real not null,
  is_default integer not null default 0,
  created_at text not null
);

create table if not exists nodes (
  id text primary key,
  title text,
  status text not null check (status in ('sealed', 'archived')),
  agent_kind text,
  shell text,
  session_file text,
  snapshot_ref text not null,
  branch_mode text,
  repo_root text,
  created_at text not null
);

create table if not exists runners (
  id text primary key,
  source_node_id text,
  sealed_node_id text,
  agent_kind text not null default 'shell',
  shell text,
  title text,
  provenance text,
  session_id text,
  session_file text,
  cwd text not null,
  worktree_path text not null,
  pty_pid integer,
  cols integer not null,
  rows integer not null,
  status text not null check (status in ('starting', 'running', 'hibernated', 'exited')),
  hibernated_at text,
  last_active_at text,
  created_at text not null
);

create table if not exists lineage_edges (
  id text primary key,
  parent_node_id text not null references nodes(id),
  child_node_id text not null references nodes(id),
  fork_turn integer,
  branch_mode text,
  created_at text not null
);

create table if not exists workspace_snapshots (
  id text primary key,
  node_id text not null references nodes(id),
  commit_hash text not null,
  ref_name text not null,
  repo_root text not null,
  created_at text not null
);

create table if not exists workflows (
  id text primary key,
  name text not null,
  auto_start_default integer not null default 0,
  created_at text not null
);

create table if not exists workflow_runs (
  id text primary key,
  workflow_id text not null references workflows(id),
  run_number integer not null,
  status text not null check (status in ('pending','running','completed','failed','cancelled')),
  trigger_kind text not null check (trigger_kind in ('manual','signal','reset')),
  created_at text not null,
  started_at text,
  completed_at text,
  unique (workflow_id, run_number)
);

create table if not exists workflow_memberships (
  runner_id text not null references runners(id),
  workflow_id text not null references workflows(id),
  join_policy text not null check (join_policy in ('all_of', 'any_of')) default 'all_of',
  edges_exist integer not null default 0,
  added_at text not null,
  primary key (runner_id, workflow_id)
);

create table if not exists dependency_edges (
  id text primary key,
  workflow_id text not null references workflows(id),
  source_runner_id text not null references runners(id),
  target_runner_id text not null references runners(id),
  signal_type text not null default 'explicit',
  signal_config text,
  condition text not null default 'always',
  created_at text not null
);

create table if not exists message_edges (
  id text primary key,
  source_runner_id text not null references runners(id),
  target_runner_id text not null references runners(id),
  created_at text not null
);

create table if not exists message_queue (
  id text primary key,
  source_runner_id text not null references runners(id),
  target_runner_id text not null references runners(id),
  payload_text text not null,
  status text not null check (status in ('pending','delivered')) default 'pending',
  created_at text not null,
  delivered_at text
);

create table if not exists runner_workflow_state (
  runner_id text not null references runners(id),
  workflow_id text not null references workflows(id),
  state text not null check (state in ('waiting','ready','running','completed','failed','skipped')),
  signal_emitted_at text,
  signal_type text,
  updated_at text not null,
  primary key (runner_id, workflow_id)
);

create table if not exists session_links (
  id text primary key,
  node_id text,
  runner_id text,
  agent_kind text not null,
  session_id text not null,
  provenance text not null,
  session_file text,
  created_at text not null
);

create table if not exists agent_profiles (
  id text primary key,
  name text not null,
  agent_kind text,
  instruction_layers text,
  model_preference text,
  memory_config text,
  mcp_packs text,
  skill_packs text,
  policy_config text,
  created_at text not null,
  updated_at text not null
);

create table if not exists runner_profile_snapshots (
  id text primary key,
  runner_id text not null references runners(id),
  profile_id text references agent_profiles(id),
  snapshot_json text not null,
  captured_at text not null
);

create table if not exists workspace_resources (
  id text primary key,
  repo_root text not null,
  display_label text not null,
  canonical_path text not null,
  mount_mode text not null check (mount_mode in ('isolated_snapshot','shared_rw','shared_ro','ephemeral_scratch','external_mount')),
  owner_runner_id text,
  is_writable integer not null default 1,
  dirty_summary text,
  risk_flags text,
  created_at text not null
);

create table if not exists workspace_resource_attachments (
  id text primary key,
  resource_id text not null references workspace_resources(id),
  runner_id text not null references runners(id),
  role text not null check (role in ('owner','collaborator','observer')),
  created_at text not null
);

create table if not exists signal_ledger (
  id text primary key,
  runner_id text not null references runners(id),
  workflow_id text not null,
  signal_type text not null,
  source_kind text not null check (source_kind in ('authoritative','heuristic')),
  fired_at text not null,
  detail text
);

create table if not exists helper_node_configs (
  runner_id text primary key references runners(id),
  helper_kind text not null check (helper_kind in ('text_node','signal_router','approval_gate','artifact_watcher','review_diff','browser_preview')),
  config_json text not null default '{}',
  gate_approved integer not null default 0,
  gate_approved_at text
);

create table if not exists terminal_buffers (
  id text primary key,
  runner_id text not null references runners(id),
  data_path text not null,
  byte_size integer not null default 0,
  created_at text not null
);

create table if not exists workspace_panels (
  id text primary key,
  view_id text not null references canvas_views(id),
  workflow_id text,
  panel_kind text not null check (panel_kind in ('runner', 'checkpoint_preview', 'helper')),
  node_id text,
  runner_id text not null references runners(id),
  x real not null,
  y real not null,
  width real not null,
  height real not null,
  z_index integer not null default 0,
  is_collapsed integer not null default 0,
  created_at text not null
);
`;
