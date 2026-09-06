-- =====================================================================
-- WHITEMOON-FINCAS-DEMO — esquema de la demo de administración de fincas
-- =====================================================================
-- Datos FICTICIOS de demostración. El "RAG" de protocolos NO usa embeddings:
-- es una tabla ESTRUCTURADA por comunidad (fincas_protocolos) más búsqueda
-- de texto de Postgres (tsvector español) para las dudas libres.
--
-- RLS: anon sólo puede SELECT (el panel de demo lee en directo). Todas las
-- escrituras pasan por Edge Functions con service role, que salta RLS.
-- =====================================================================

-- ---------------------------------------------------------------- comunidades
create table if not exists fincas_comunidades (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique,
  direccion   text not null,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------- inmuebles
create table if not exists fincas_inmuebles (
  id                 uuid primary key default gen_random_uuid(),
  comunidad_id       uuid not null references fincas_comunidades(id) on delete cascade,
  puerta             text not null,
  propietario_nombre text not null,
  propietario_tel    text,
  created_at         timestamptz not null default now(),
  unique (comunidad_id, puerta)
);
create index if not exists fincas_inmuebles_comunidad_idx on fincas_inmuebles (comunidad_id);

-- --------------------------------------------------------------- proveedores
create table if not exists fincas_proveedores (
  id           uuid primary key default gen_random_uuid(),
  comunidad_id uuid not null references fincas_comunidades(id) on delete cascade,
  nombre       text not null,
  tel          text,
  especialidad text,
  created_at   timestamptz not null default now()
);
create index if not exists fincas_proveedores_comunidad_idx on fincas_proveedores (comunidad_id);

-- ---------------------------------------------------------------- protocolos
-- El corazón de la demo. Cada fila es "qué hace ESTA comunidad ante ESTE
-- caso". `palabras_clave` alimenta el tsvector para que la búsqueda libre
-- ("se ha quedado tirado el elevador") encuentre el protocolo correcto.
create table if not exists fincas_protocolos (
  id               uuid primary key default gen_random_uuid(),
  comunidad_id     uuid not null references fincas_comunidades(id) on delete cascade,
  categoria        text not null,
  subtipo          text not null,
  proveedor_nombre text not null,
  proveedor_tel    text,
  urgencia_default text not null default 'media',
  pasos            jsonb not null default '[]'::jsonb,
  cita_fuente      text not null,
  palabras_clave   text not null default '',
  created_at       timestamptz not null default now(),
  unique (comunidad_id, categoria, subtipo),
  constraint fincas_protocolos_urgencia_chk
    check (urgencia_default in ('critica','alta','media','baja')),
  busqueda tsvector generated always as (
    to_tsvector(
      'spanish',
      coalesce(categoria, '') || ' ' ||
      coalesce(subtipo, '') || ' ' ||
      coalesce(palabras_clave, '') || ' ' ||
      coalesce(proveedor_nombre, '') || ' ' ||
      coalesce(cita_fuente, '') || ' ' ||
      coalesce(pasos::text, '')
    )
  ) stored
);
create index if not exists fincas_protocolos_comunidad_idx on fincas_protocolos (comunidad_id);
create index if not exists fincas_protocolos_busqueda_idx  on fincas_protocolos using gin (busqueda);

-- --------------------------------------------------------------- expedientes
-- `ref` es el identificador humano EXP-AAAA-NNNN que se le dice al vecino.
create sequence if not exists fincas_exp_seq start 1;

create table if not exists fincas_expedientes (
  id               uuid primary key default gen_random_uuid(),
  ref              text not null unique
                     default 'EXP-' || to_char(now(), 'YYYY') || '-' ||
                             lpad(nextval('fincas_exp_seq')::text, 4, '0'),
  comunidad_id     uuid not null references fincas_comunidades(id) on delete cascade,
  inmueble_id      uuid references fincas_inmuebles(id) on delete set null,
  tipo             text not null,
  subtipo          text,
  urgencia         text not null default 'media',
  estado           text not null default 'nuevo',
  descripcion      text,
  protocolo_id     uuid references fincas_protocolos(id) on delete set null,
  protocolo_citado text,
  proveedor_nombre text,
  proveedor_tel    text,
  proveedor_avisado_at timestamptz,
  created_at       timestamptz not null default now(),
  constraint fincas_expedientes_estado_chk
    check (estado in ('nuevo','asignado','en_curso','cerrado')),
  constraint fincas_expedientes_urgencia_chk
    check (urgencia in ('critica','alta','media','baja'))
);
create index if not exists fincas_expedientes_comunidad_idx on fincas_expedientes (comunidad_id);
create index if not exists fincas_expedientes_estado_idx    on fincas_expedientes (estado);

-- -------------------------------------------------------------- presupuestos
-- Cola de aprobación: la IA prepara, el administrador decide.
create table if not exists fincas_presupuestos (
  id               uuid primary key default gen_random_uuid(),
  expediente_id    uuid not null references fincas_expedientes(id) on delete cascade,
  proveedor_nombre text not null,
  importe          numeric(10,2) not null,
  partidas         jsonb not null default '[]'::jsonb,
  estado           text not null default 'pendiente',
  decidido_por     text,
  decidido_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint fincas_presupuestos_estado_chk
    check (estado in ('pendiente','aprobado','rechazado'))
);
create index if not exists fincas_presupuestos_expediente_idx on fincas_presupuestos (expediente_id);
create index if not exists fincas_presupuestos_estado_idx     on fincas_presupuestos (estado);

-- ----------------------------------------------------------------- auditoría
-- Append-only de verdad: el trigger corta UPDATE y DELETE incluso con
-- service role, que es quien escribe aquí.
create table if not exists fincas_auditoria (
  id         uuid primary key default gen_random_uuid(),
  actor      text not null,
  accion     text not null,
  entidad    text not null,
  detalle    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fincas_auditoria_created_idx on fincas_auditoria (created_at desc);

create or replace function fincas_auditoria_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'fincas_auditoria es append-only: % no está permitido', tg_op;
end;
$$;

drop trigger if exists fincas_auditoria_no_touch on fincas_auditoria;
create trigger fincas_auditoria_no_touch
  before update or delete on fincas_auditoria
  for each row execute function fincas_auditoria_append_only();

-- =====================================================================
-- fincas_buscar_protocolo — ÚNICA puerta de entrada a los protocolos.
-- =====================================================================
-- El filtro por comunidad NO es un parámetro opcional del que haya que
-- acordarse: está cableado en el WHERE. Si llega p_comunidad nulo la
-- comparación es nula y la función devuelve 0 filas — falla cerrada, nunca
-- devuelve "todos los protocolos". Por eso el agente no puede filtrar mal:
-- no tiene forma de consultar sin comunidad.
create or replace function fincas_buscar_protocolo(
  p_comunidad uuid,
  p_consulta  text default null
)
returns table (
  id uuid, comunidad_id uuid, categoria text, subtipo text,
  proveedor_nombre text, proveedor_tel text, urgencia_default text,
  pasos jsonb, cita_fuente text
)
language sql
stable
as $$
  select p.id, p.comunidad_id, p.categoria, p.subtipo,
         p.proveedor_nombre, p.proveedor_tel, p.urgencia_default,
         p.pasos, p.cita_fuente
  from fincas_protocolos p
  where p.comunidad_id = p_comunidad
    and (
      p_consulta is null
      or btrim(p_consulta) = ''
      or p.categoria ilike '%' || btrim(p_consulta) || '%'
      or p.subtipo   ilike '%' || btrim(p_consulta) || '%'
      or p.busqueda @@ plainto_tsquery('spanish', p_consulta)
    )
  order by
    ts_rank(p.busqueda, plainto_tsquery('spanish', coalesce(p_consulta, ''))) desc,
    p.categoria, p.subtipo
  limit 5;
$$;

-- =====================================================================
-- RLS — anon lee, nadie escribe salvo service role (que salta RLS).
-- =====================================================================
alter table fincas_comunidades  enable row level security;
alter table fincas_inmuebles    enable row level security;
alter table fincas_proveedores  enable row level security;
alter table fincas_protocolos   enable row level security;
alter table fincas_expedientes  enable row level security;
alter table fincas_presupuestos enable row level security;
alter table fincas_auditoria    enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'fincas_comunidades','fincas_inmuebles','fincas_proveedores',
    'fincas_protocolos','fincas_expedientes','fincas_presupuestos',
    'fincas_auditoria'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_select_demo', t);
    execute format(
      'create policy %I on %I for select to anon, authenticated using (true)',
      t || '_select_demo', t
    );
  end loop;
end;
$$;

-- Realtime para el kanban y la cola de aprobación.
alter table fincas_expedientes  replica identity full;
alter table fincas_presupuestos replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table fincas_expedientes;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table fincas_presupuestos;
  exception when duplicate_object then null;
  end;
end $$;
