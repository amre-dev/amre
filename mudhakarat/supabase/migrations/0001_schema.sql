-- مذاكراتي: المخطط الكامل (الحالة النهائية المطبّقة على المشروع).
-- شغّله في SQL Editor على مشروع Supabase جديد لإعادة إنشاء كل شيء.

-- ───────── الجداول ─────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  ai_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_scale numeric not null default 100 check (display_scale > 0 and display_scale <= 100000),
  default_goal numeric not null default 90 check (default_goal >= 0 and default_goal <= 100),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  default_full_mark numeric not null check (default_full_mark > 0 and default_full_mark <= 100000),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);

create table public.months (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month_key text not null check (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  goal_pct numeric check (goal_pct is null or (goal_pct >= 0 and goal_pct <= 100)),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, month_key)
);

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subject_id uuid references public.subjects(id) on delete set null,
  subject_name text not null check (char_length(btrim(subject_name)) between 1 and 80),
  title text not null default '' check (char_length(title) <= 300),
  notes text not null default '' check (char_length(notes) <= 1000),
  exam_date date not null,
  full_mark numeric not null check (full_mark > 0 and full_mark <= 100000),
  expected_mark numeric check (expected_mark is null or expected_mark >= 0),
  actual_mark numeric check (actual_mark is null or actual_mark >= 0),
  status text not null default 'upcoming' check (status in ('upcoming', 'awaiting', 'completed')),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  constraint exams_expected_le_full check (expected_mark is null or expected_mark <= full_mark),
  constraint exams_actual_le_full check (actual_mark is null or actual_mark <= full_mark),
  constraint exams_status_matches_actual check ((status = 'completed') = (actual_mark is not null))
);

create index exams_user_date_idx on public.exams (user_id, exam_date);
create index exams_user_sync_idx on public.exams (user_id, server_updated_at);
create index exams_subject_idx on public.exams (subject_id);
create index months_user_sync_idx on public.months (user_id, server_updated_at);
create index subjects_user_sync_idx on public.subjects (user_id, server_updated_at);

-- ───────── الدوال والمشغّلات ─────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'display_name', ''), 60));
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- الأحدث يفوز: كتابة أقدم من النسخة الموجودة تُتجاهل، ولا يمكن تغيير مالك الصف.
create or replace function public.sync_guard() returns trigger
language plpgsql set search_path to '' as $$
begin
  new.updated_at := least(coalesce(new.updated_at, now()), now() + interval '5 minutes');
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    if new.updated_at < old.updated_at then
      return null;
    end if;
  end if;
  new.server_updated_at := now();
  return new;
end;
$$;
create trigger subjects_sync_guard before insert or update on public.subjects for each row execute function public.sync_guard();
create trigger months_sync_guard before insert or update on public.months for each row execute function public.sync_guard();
create trigger exams_sync_guard before insert or update on public.exams for each row execute function public.sync_guard();
create trigger user_settings_sync_guard before insert or update on public.user_settings for each row execute function public.sync_guard();

-- ───────── RLS ─────────
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.subjects enable row level security;
alter table public.months enable row level security;
alter table public.exams enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

do $$
declare t text;
begin
  foreach t in array array['user_settings', 'subjects', 'months', 'exams'] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t || '_delete_own', t);
  end loop;
end $$;

-- ───────── الصلاحيات (أقل ما يلزم) ─────────
revoke all on public.profiles, public.user_settings, public.subjects, public.months, public.exams from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;   -- ai_enabled لا يعدّله أي مستخدم
grant select, insert, update, delete on public.user_settings, public.subjects, public.months, public.exams to authenticated;

-- تفعيل الذكاء الاصطناعي لحسابك أنت فقط (بعد التسجيل):
--   update public.profiles set ai_enabled = true where id = (select id from auth.users where email = 'بريدك@example.com');
