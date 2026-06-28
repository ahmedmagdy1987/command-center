-- Stripe sandbox billing Phase 1 rolled-back database security proof.
--
-- Execute with Supabase MCP execute_sql or the Supabase SQL editor against project
-- nqlzjuxqgajeoypyzlnv. This script intentionally creates proposed objects inside
-- one transaction and ends with ROLLBACK. It must not be converted into a migration.

begin;

create temp table billing_proof_results (
  id bigserial primary key,
  label text not null,
  ok boolean not null,
  detail text
);

create or replace function pg_temp.record_result(p_label text, p_ok boolean, p_detail text default null)
returns void
language plpgsql
as $$
begin
  insert into pg_temp.billing_proof_results(label, ok, detail)
  values (p_label, p_ok, p_detail);
  if p_ok then
    raise notice 'PASS: %', p_label;
  else
    raise warning 'FAIL: % -- %', p_label, coalesce(p_detail, '');
  end if;
end;
$$;

create or replace function pg_temp.assert_eq(p_label text, p_actual text, p_expected text)
returns void
language plpgsql
as $$
begin
  perform pg_temp.record_result(
    p_label,
    p_actual is not distinct from p_expected,
    format('expected=%s actual=%s', p_expected, p_actual)
  );
end;
$$;

create or replace function pg_temp.assert_bigint_eq(p_label text, p_actual bigint, p_expected bigint)
returns void
language plpgsql
as $$
begin
  perform pg_temp.record_result(
    p_label,
    p_actual is not distinct from p_expected,
    format('expected=%s actual=%s', p_expected, p_actual)
  );
end;
$$;

create or replace function pg_temp.assert_bool_eq(p_label text, p_actual boolean, p_expected boolean)
returns void
language plpgsql
as $$
begin
  perform pg_temp.record_result(
    p_label,
    p_actual is not distinct from p_expected,
    format('expected=%s actual=%s', p_expected, p_actual)
  );
end;
$$;

create or replace function pg_temp.assert_sqlstate(p_label text, p_expected_sqlstate text, p_sql text)
returns void
language plpgsql
as $$
declare
  v_state text;
begin
  begin
    execute p_sql;
    perform pg_temp.record_result(p_label, false, 'expected SQLSTATE ' || p_expected_sqlstate || ', but statement succeeded');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform pg_temp.record_result(
      p_label,
      v_state = p_expected_sqlstate,
      format('expected SQLSTATE=%s actual SQLSTATE=%s', p_expected_sqlstate, v_state)
    );
  end;
end;
$$;

create or replace function pg_temp.impersonate(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
end;
$$;

create or replace function pg_temp.as_service()
returns void
language plpgsql
as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
end;
$$;

create table private.workspace_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  internal_plan_id text not null default 'free',
  billing_interval text,
  subscription_status text not null default 'none',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  last_stripe_event_id text,
  last_stripe_event_created timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_subscriptions_plan_check
    check (internal_plan_id in ('free','pro','business','founding')),
  constraint workspace_subscriptions_interval_check
    check (billing_interval is null or billing_interval in ('monthly','annual')),
  constraint workspace_subscriptions_status_check
    check (subscription_status in (
      'none',
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused'
    )),
  constraint workspace_subscriptions_period_check
    check (current_period_start is null or current_period_end is null or current_period_end >= current_period_start)
);

create unique index workspace_subscriptions_workspace_key
  on private.workspace_subscriptions(workspace_id);
create unique index workspace_subscriptions_customer_key
  on private.workspace_subscriptions(stripe_customer_id)
  where stripe_customer_id is not null;
create unique index workspace_subscriptions_subscription_key
  on private.workspace_subscriptions(stripe_subscription_id)
  where stripe_subscription_id is not null;
create index workspace_subscriptions_status_idx
  on private.workspace_subscriptions(subscription_status, internal_plan_id);

alter table private.workspace_subscriptions enable row level security;
revoke all on table private.workspace_subscriptions from public, anon, authenticated;

create table private.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  stripe_created timestamptz not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text,
  processed_at timestamptz not null default now(),
  processing_error text
);

create index stripe_webhook_events_workspace_created_idx
  on private.stripe_webhook_events(workspace_id, stripe_created desc);
create index stripe_webhook_events_subscription_idx
  on private.stripe_webhook_events(stripe_subscription_id);

alter table private.stripe_webhook_events enable row level security;
revoke all on table private.stripe_webhook_events from public, anon, authenticated;

create or replace function public.get_workspace_billing_summary(p_workspace_id uuid)
returns table (
  workspace_id uuid,
  effective_plan_id text,
  internal_plan_id text,
  subscription_status text,
  billing_interval text,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  trial_end timestamptz,
  can_manage_billing boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select wm.role
    into v_role
    from public.workspace_members wm
   where wm.workspace_id = p_workspace_id
     and wm.user_id = v_uid;

  if v_role is null then
    return;
  end if;

  return query
  select
    p_workspace_id,
    case
      when s.internal_plan_id in ('pro','business')
       and s.subscription_status in ('trialing','active')
       and (s.current_period_end is null or s.current_period_end > now())
        then s.internal_plan_id
      when s.internal_plan_id = 'founding'
       and s.subscription_status in ('none','active','trialing')
        then 'founding'
      else 'free'
    end as effective_plan_id,
    case when v_role = 'owner' then coalesce(s.internal_plan_id, 'free') else null end as internal_plan_id,
    case when v_role = 'owner' then coalesce(s.subscription_status, 'none') else null end as subscription_status,
    case when v_role = 'owner' then s.billing_interval else null end as billing_interval,
    case when v_role = 'owner' then s.current_period_end else null end as current_period_end,
    case when v_role = 'owner' then coalesce(s.cancel_at_period_end, false) else null end as cancel_at_period_end,
    case when v_role = 'owner' then s.trial_end else null end as trial_end,
    (v_role = 'owner') as can_manage_billing
  from (select 1) seed
  left join private.workspace_subscriptions s on s.workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.get_workspace_billing_summary(uuid) from public, anon;
grant execute on function public.get_workspace_billing_summary(uuid) to authenticated;

create or replace function private._apply_stripe_subscription_event(
  p_workspace_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_internal_plan_id text,
  p_billing_interval text,
  p_subscription_status text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_trial_end timestamptz,
  p_event_id text,
  p_event_created timestamptz,
  p_event_type text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int;
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required' using errcode = '22023';
  end if;
  if p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'event_id is required' using errcode = '22023';
  end if;
  if p_stripe_customer_id is null or btrim(p_stripe_customer_id) = '' then
    raise exception 'stripe_customer_id is required' using errcode = '22023';
  end if;

  insert into private.stripe_webhook_events (
    event_id,
    event_type,
    stripe_created,
    workspace_id,
    stripe_customer_id,
    stripe_subscription_id
  )
  values (
    p_event_id,
    p_event_type,
    p_event_created,
    p_workspace_id,
    p_stripe_customer_id,
    p_stripe_subscription_id
  )
  on conflict (event_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;
  end if;

  if p_stripe_subscription_id is not null and exists (
    select 1
      from private.workspace_subscriptions s
     where s.stripe_subscription_id = p_stripe_subscription_id
       and s.workspace_id <> p_workspace_id
  ) then
    raise exception 'stripe subscription already mapped to another workspace'
      using errcode = '23505';
  end if;

  if exists (
    select 1
      from private.workspace_subscriptions s
     where s.stripe_customer_id = p_stripe_customer_id
       and s.workspace_id <> p_workspace_id
  ) then
    raise exception 'stripe customer already mapped to another workspace'
      using errcode = '23505';
  end if;

  insert into private.workspace_subscriptions (
    workspace_id,
    stripe_customer_id,
    stripe_subscription_id,
    stripe_price_id,
    internal_plan_id,
    billing_interval,
    subscription_status,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    trial_end,
    last_stripe_event_id,
    last_stripe_event_created,
    updated_at
  )
  values (
    p_workspace_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_stripe_price_id,
    p_internal_plan_id,
    p_billing_interval,
    p_subscription_status,
    p_current_period_start,
    p_current_period_end,
    coalesce(p_cancel_at_period_end, false),
    p_trial_end,
    p_event_id,
    p_event_created,
    now()
  )
  on conflict (workspace_id) do update
     set stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_price_id = excluded.stripe_price_id,
         internal_plan_id = excluded.internal_plan_id,
         billing_interval = excluded.billing_interval,
         subscription_status = excluded.subscription_status,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         trial_end = excluded.trial_end,
         last_stripe_event_id = excluded.last_stripe_event_id,
         last_stripe_event_created = excluded.last_stripe_event_created,
         updated_at = now()
   where private.workspace_subscriptions.last_stripe_event_created is null
      or excluded.last_stripe_event_created >= private.workspace_subscriptions.last_stripe_event_created;

  return true;
end;
$$;

revoke all on function private._apply_stripe_subscription_event(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function private._apply_stripe_subscription_event(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, timestamptz, text
) to service_role;

do $proof$
declare
  v_tony uuid;
  v_ahmed uuid;
  v_va uuid;
  v_ws_owner uuid := '71000000-0000-4000-8000-000000000001';
  v_ws_guest uuid := '71000000-0000-4000-8000-000000000002';
  v_ws_other uuid := '71000000-0000-4000-8000-000000000003';
  v_count bigint;
  v_text text;
  v_bool boolean;
  v_private_apply_oid oid;
  v_public_summary_oid oid;
begin
  select id into v_tony from public.members where lower(email) = 'ciorciaritony@gmail.com' limit 1;
  select id into v_ahmed from public.members where lower(email) = 'ahmedkassim157@gmail.com' limit 1;
  select id into v_va from public.members where lower(email) = 'ahmedkassim17777@gmail.com' limit 1;

  if v_tony is null or v_ahmed is null or v_va is null then
    raise exception 'Required existing proof users were not found in public.members';
  end if;

  insert into public.workspaces(id, name, owner_id, slug)
  values
    (v_ws_owner, 'Billing Proof Owner Workspace', v_tony, 'billing-proof-owner-ws'),
    (v_ws_guest, 'Billing Proof Guest Workspace', v_ahmed, 'billing-proof-guest-ws'),
    (v_ws_other, 'Billing Proof Other Workspace', v_ahmed, 'billing-proof-other-ws');

  insert into public.workspace_members(workspace_id, user_id, role)
  values
    (v_ws_owner, v_tony, 'owner'),
    (v_ws_owner, v_ahmed, 'admin'),
    (v_ws_owner, v_va, 'member'),
    (v_ws_guest, v_ahmed, 'owner'),
    (v_ws_guest, v_tony, 'guest'),
    (v_ws_guest, v_va, 'member'),
    (v_ws_other, v_ahmed, 'owner'),
    (v_ws_other, v_va, 'member');

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_pro_monthly',
    'pro',
    'monthly',
    'active',
    now() - interval '1 day',
    now() + interval '30 days',
    false,
    null,
    'evt_billing_initial_active',
    now(),
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('trusted webhook path processed initial event', v_bool, true);

  select count(*) into v_count
    from private.workspace_subscriptions
   where workspace_id = v_ws_owner
     and subscription_status = 'active'
     and internal_plan_id = 'pro';
  perform pg_temp.assert_bigint_eq('trusted webhook path updated correct workspace row', v_count, 1);

  perform pg_temp.impersonate(v_tony);
  select count(*) into v_count from public.get_workspace_billing_summary(v_ws_owner);
  perform pg_temp.assert_bigint_eq('owner can read safe billing summary for own workspace', v_count, 1);
  select effective_plan_id into v_text from public.get_workspace_billing_summary(v_ws_owner);
  perform pg_temp.assert_eq('owner summary shows paid effective plan while active', v_text, 'pro');
  select count(*) into v_count from public.get_workspace_billing_summary(v_ws_other);
  perform pg_temp.assert_bigint_eq('owner cannot read another workspace billing state', v_count, 0);
  perform pg_temp.as_service();

  perform pg_temp.impersonate(v_ahmed);
  perform pg_temp.assert_sqlstate(
    'admin cannot directly insert a paid subscription',
    '42501',
    format(
      $sql$insert into private.workspace_subscriptions(workspace_id, internal_plan_id, subscription_status)
            values (%L, 'business', 'active')$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'admin cannot directly alter subscription status',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set subscription_status = 'active'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.as_service();

  perform pg_temp.impersonate(v_va);
  perform pg_temp.assert_sqlstate(
    'member cannot directly insert billing state',
    '42501',
    format(
      $sql$insert into private.workspace_subscriptions(workspace_id, internal_plan_id, subscription_status)
            values (%L, 'pro', 'active')$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'member cannot directly update billing state',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set internal_plan_id = 'business'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.as_service();

  perform pg_temp.impersonate(v_tony);
  perform pg_temp.assert_sqlstate(
    'guest cannot directly insert billing state',
    '42501',
    format(
      $sql$insert into private.workspace_subscriptions(workspace_id, internal_plan_id, subscription_status)
            values (%L, 'pro', 'active')$sql$,
      v_ws_guest
    )
  );
  perform pg_temp.assert_sqlstate(
    'guest cannot directly update billing state',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set subscription_status = 'active'
            where workspace_id = %L$sql$,
      v_ws_guest
    )
  );
  select count(*) into v_count from public.get_workspace_billing_summary(v_ws_other);
  perform pg_temp.assert_bigint_eq('outsider reads zero billing rows through safe summary', v_count, 0);
  perform pg_temp.assert_sqlstate(
    'outsider cannot insert billing records',
    '42501',
    format(
      $sql$insert into private.workspace_subscriptions(workspace_id, internal_plan_id, subscription_status)
            values (%L, 'pro', 'active')$sql$,
      v_ws_other
    )
  );
  perform pg_temp.assert_sqlstate(
    'outsider cannot update billing records',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set internal_plan_id = 'business'
            where workspace_id = %L$sql$,
      v_ws_other
    )
  );
  perform pg_temp.assert_sqlstate(
    'outsider cannot delete billing records',
    '42501',
    format(
      $sql$delete from private.workspace_subscriptions
            where workspace_id = %L$sql$,
      v_ws_other
    )
  );
  perform pg_temp.as_service();

  perform pg_temp.impersonate(v_va);
  perform pg_temp.assert_sqlstate(
    'authenticated browser user cannot assign themselves Pro',
    '42501',
    format(
      $sql$insert into private.workspace_subscriptions(workspace_id, internal_plan_id)
            values (%L, 'pro')$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'authenticated browser user cannot inject stripe_customer_id',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set stripe_customer_id = 'cus_injected'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'authenticated browser user cannot inject stripe_subscription_id',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set stripe_subscription_id = 'sub_injected'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'authenticated browser user cannot inject stripe_price_id',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set stripe_price_id = 'price_injected'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'authenticated browser user cannot inject active status',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set subscription_status = 'active'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.assert_sqlstate(
    'authenticated browser user cannot inject subscription period dates',
    '42501',
    format(
      $sql$update private.workspace_subscriptions
              set current_period_start = now(), current_period_end = now() + interval '1 year'
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.as_service();

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_pro_monthly',
    'pro',
    'monthly',
    'canceled',
    now() - interval '1 day',
    now() + interval '30 days',
    false,
    null,
    'evt_billing_duplicate',
    now() + interval '1 minute',
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('first duplicate-test event is processed', v_bool, true);

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_business_yearly',
    'business',
    'annual',
    'canceled',
    now() - interval '1 day',
    now() + interval '1 year',
    false,
    null,
    'evt_billing_duplicate',
    now() + interval '2 minutes',
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('duplicated Stripe event ID is ignored', v_bool, false);

  select count(*) into v_count
    from private.stripe_webhook_events
   where event_id = 'evt_billing_duplicate';
  perform pg_temp.assert_bigint_eq('duplicated Stripe event ID is recorded at most once', v_count, 1);

  select subscription_status into v_text
    from private.workspace_subscriptions
   where workspace_id = v_ws_owner;
  perform pg_temp.assert_eq('duplicate event cannot overwrite existing subscription state', v_text, 'canceled');

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_pro_monthly',
    'pro',
    'monthly',
    'active',
    now() - interval '1 day',
    now() + interval '30 days',
    false,
    null,
    'evt_billing_newer_active',
    now() + interval '3 minutes',
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('newer subscription event is processed', v_bool, true);

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_business_yearly',
    'business',
    'annual',
    'canceled',
    now() - interval '10 days',
    now() + interval '1 year',
    false,
    null,
    'evt_billing_stale',
    now() - interval '1 day',
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('out-of-order stale event is recorded but not applied', v_bool, true);

  select subscription_status into v_text
    from private.workspace_subscriptions
   where workspace_id = v_ws_owner;
  perform pg_temp.assert_eq('out-of-order event cannot overwrite newer state', v_text, 'active');

  perform pg_temp.assert_sqlstate(
    'Stripe subscription cannot map to two workspaces',
    '23505',
    format(
      $sql$select private._apply_stripe_subscription_event(
        %L::uuid,
        'cus_sandbox_other_subscription_conflict',
        'sub_sandbox_owner',
        'price_sandbox_pro_monthly',
        'pro',
        'monthly',
        'active',
        now() - interval '1 day',
        now() + interval '30 days',
        false,
        null,
        'evt_billing_subscription_conflict',
        now() + interval '4 minutes',
        'customer.subscription.updated'
      )$sql$,
      v_ws_other
    )
  );

  perform pg_temp.assert_sqlstate(
    'Stripe customer cannot map to two unrelated workspaces',
    '23505',
    format(
      $sql$select private._apply_stripe_subscription_event(
        %L::uuid,
        'cus_sandbox_owner',
        'sub_sandbox_other_customer_conflict',
        'price_sandbox_pro_monthly',
        'pro',
        'monthly',
        'active',
        now() - interval '1 day',
        now() + interval '30 days',
        false,
        null,
        'evt_billing_customer_conflict',
        now() + interval '5 minutes',
        'customer.subscription.updated'
      )$sql$,
      v_ws_other
    )
  );

  select count(*) into v_count
    from private.workspace_subscriptions
   where workspace_id = v_ws_other;
  perform pg_temp.assert_bigint_eq('trusted webhook update cannot modify a different tenant', v_count, 0);

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_pro_monthly',
    'pro',
    'monthly',
    'canceled',
    now() - interval '30 days',
    now(),
    false,
    null,
    'evt_billing_canceled',
    now() + interval '6 minutes',
    'customer.subscription.deleted'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('subscription cancellation event is processed', v_bool, true);

  perform pg_temp.impersonate(v_tony);
  select effective_plan_id into v_text from public.get_workspace_billing_summary(v_ws_owner);
  perform pg_temp.assert_eq('subscription cancellation falls back to free effective plan', v_text, 'free');
  select subscription_status into v_text from public.get_workspace_billing_summary(v_ws_owner);
  perform pg_temp.assert_eq('subscription cancellation preserves canceled status for owner summary', v_text, 'canceled');
  perform pg_temp.as_service();

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_pro_monthly',
    'pro',
    'monthly',
    'past_due',
    now() - interval '1 day',
    now() + interval '30 days',
    false,
    null,
    'evt_billing_past_due',
    now() + interval '7 minutes',
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('past_due event is processed', v_bool, true);

  perform pg_temp.impersonate(v_tony);
  select effective_plan_id into v_text from public.get_workspace_billing_summary(v_ws_owner);
  perform pg_temp.assert_eq('past_due subscription follows safe free entitlement policy', v_text, 'free');
  perform pg_temp.as_service();

  select private._apply_stripe_subscription_event(
    v_ws_owner,
    'cus_sandbox_owner',
    'sub_sandbox_owner',
    'price_sandbox_pro_monthly',
    'pro',
    'monthly',
    'unpaid',
    now() - interval '1 day',
    now() + interval '30 days',
    false,
    null,
    'evt_billing_unpaid',
    now() + interval '8 minutes',
    'customer.subscription.updated'
  ) into v_bool;
  perform pg_temp.assert_bool_eq('unpaid event is processed', v_bool, true);

  perform pg_temp.impersonate(v_tony);
  select effective_plan_id into v_text from public.get_workspace_billing_summary(v_ws_owner);
  perform pg_temp.assert_eq('unpaid subscription follows safe free entitlement policy', v_text, 'free');
  perform pg_temp.as_service();

  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (
     ('public', 'get_workspace_billing_summary'),
     ('private', '_apply_stripe_subscription_event')
   )
     and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%';
  perform pg_temp.assert_bigint_eq('all SECURITY DEFINER functions use an empty search_path', v_count, 2);

  select p.oid into v_private_apply_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname = '_apply_stripe_subscription_event';

  select p.oid into v_public_summary_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_workspace_billing_summary';

  perform pg_temp.assert_bool_eq(
    'private webhook apply function execute revoked from authenticated',
    has_function_privilege('authenticated', v_private_apply_oid, 'execute'),
    false
  );
  perform pg_temp.assert_bool_eq(
    'private webhook apply function execute granted only to service_role path',
    has_function_privilege('service_role', v_private_apply_oid, 'execute'),
    true
  );
  perform pg_temp.assert_bool_eq(
    'safe summary RPC execute revoked from anon',
    has_function_privilege('anon', v_public_summary_oid, 'execute'),
    false
  );
  perform pg_temp.assert_bool_eq(
    'safe summary RPC execute granted to authenticated',
    has_function_privilege('authenticated', v_public_summary_oid, 'execute'),
    true
  );

  perform pg_temp.impersonate(v_va);
  perform pg_temp.assert_sqlstate(
    'direct table writes from authenticated users are blocked',
    '42501',
    format(
      $sql$delete from private.workspace_subscriptions
            where workspace_id = %L$sql$,
      v_ws_owner
    )
  );
  perform pg_temp.as_service();

  perform pg_temp.impersonate(v_tony);
  select count(*) into v_count from public.get_workspace_billing_summary(v_ws_other);
  perform pg_temp.assert_bigint_eq('cross-tenant reads remain zero', v_count, 0);
  perform pg_temp.as_service();
end;
$proof$;

do $$
declare
  v_total bigint;
  v_failed bigint;
  v_failures text;
begin
  select count(*), count(*) filter (where not ok)
    into v_total, v_failed
    from pg_temp.billing_proof_results;

  if v_failed > 0 then
    select string_agg(label || ': ' || coalesce(detail, ''), E'\n' order by id)
      into v_failures
      from pg_temp.billing_proof_results
     where not ok;
    raise exception 'Stripe sandbox billing rolled-back proof failed: %/% assertions failed.%', v_failed, v_total, E'\n' || v_failures;
  end if;

  raise notice 'Stripe sandbox billing rolled-back proof passed: %/% assertions.', v_total, v_total;
end;
$$;

rollback;
