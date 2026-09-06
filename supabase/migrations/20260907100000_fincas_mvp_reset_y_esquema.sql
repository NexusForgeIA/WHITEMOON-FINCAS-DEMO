-- =====================================================================
-- Whitemoon Fincas — MVP real. Reset a vacío + esquema de producción.
-- =====================================================================
-- Esto deja de ser una demo con datos de ejemplo. Se borra el seed, se
-- endurece el acceso (anon deja de leer NADA) y se añade lo que faltaba
-- para operar de verdad: correo entrante y saliente, documentos con
-- búsqueda de texto, facturación en borrador y datos bancarios fuera del
-- alcance de la IA.
--
-- LO QUE NO CAMBIA: los protocolos siguen siendo datos ESTRUCTURADOS por
-- comunidad + búsqueda de texto de Postgres. Sin embeddings.
-- =====================================================================


-- =====================================================================
-- 1 · VACIADO
-- =====================================================================
-- Borrar las comunidades arrastra en cascada inmuebles, proveedores,
-- protocolos, expedientes y presupuestos. La auditoría se vacía con
-- TRUNCATE porque el trigger append-only bloquea DELETE — y es la única
-- vez que se hace: al final de este fichero se le pone también guardia de
-- TRUNCATE para que no vuelva a poder pasar.
delete from fincas_comunidades;
truncate fincas_auditoria;
alter sequence fincas_exp_seq restart with 1;


-- =====================================================================
-- 2 · QUIÉN ES DEL EQUIPO
-- =====================================================================
-- El CRM es privado. Un usuario de Supabase Auth sólo entra si tiene
-- perfil activo aquí. Sin fila, autenticado o no, no ve nada.
create table if not exists fincas_perfiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  nombre     text not null default '',
  rol        text not null default 'admin',
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint fincas_perfiles_rol_chk check (rol in ('admin', 'contabilidad'))
);

-- SECURITY INVOKER a propósito: no hace falta elevar privilegios y así no
-- aparece en el lint de funciones SECURITY DEFINER ejecutables por anon.
-- Para anon, auth.uid() es null, no hay fila y devuelve false.
create or replace function public.fincas_es_staff()
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from fincas_perfiles p
    where p.user_id = auth.uid() and p.activo
  );
$$;

create or replace function public.fincas_actor()
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select p.email from fincas_perfiles p where p.user_id = auth.uid()),
    nullif(current_setting('request.jwt.claim.email', true), ''),
    'servicio'
  );
$$;


-- =====================================================================
-- 3 · DATOS PROTEGIDOS — EN OTRO ESQUEMA, A PROPÓSITO
-- =====================================================================
-- IBAN y datos del presidente viven en `fincas_privado`, que NO está en la
-- lista de esquemas expuestos por PostgREST. No es una cuestión de permisos
-- que alguien pueda cambiar por error: la API REST no puede nombrar esta
-- tabla, ni con la clave anon ni con service role. La Edge Function del
-- agente, que habla con la base por PostgREST, no tiene forma de llegar
-- aquí aunque el modelo se lo invente.
--
-- El CRM del administrador los lee por la Edge Function fincas-privado,
-- que valida el JWT del admin y usa una conexión aparte.
create schema if not exists fincas_privado;
revoke all on schema fincas_privado from public, anon, authenticated;

create table if not exists fincas_privado.datos_comunidad (
  comunidad_id        uuid primary key
                        references public.fincas_comunidades(id) on delete cascade,
  presidente_nombre   text not null default '',
  presidente_contacto text not null default '',
  iban                text not null default '',
  notas               text not null default '',
  actualizado_at      timestamptz not null default now()
);
revoke all on all tables in schema fincas_privado from public, anon, authenticated;


-- =====================================================================
-- 4 · AMPLIACIONES DEL ESQUEMA EXISTENTE
-- =====================================================================
alter table fincas_comunidades
  add column if not exists cif        text not null default '',
  add column if not exists notas      text not null default '',
  add column if not exists activa     boolean not null default true;

-- El email del proveedor es el canal real de esta aplicación: sin él no se
-- puede pedir presupuesto.
alter table fincas_proveedores
  add column if not exists email      text not null default '',
  add column if not exists zona       text not null default '',
  add column if not exists notas      text not null default '',
  add column if not exists activo     boolean not null default true;

-- Un proveedor puede trabajar para varias comunidades. La columna
-- comunidad_id original se queda como "comunidad de alta" y esta tabla
-- lleva las asignaciones reales.
create table if not exists fincas_proveedor_comunidad (
  proveedor_id uuid not null references fincas_proveedores(id) on delete cascade,
  comunidad_id uuid not null references fincas_comunidades(id) on delete cascade,
  primary key (proveedor_id, comunidad_id)
);

alter table fincas_inmuebles
  add column if not exists propietario_email text not null default '',
  add column if not exists notas             text not null default '';

-- Quién ha llamado. Antes lo daba el selector de la demo; ahora lo recoge
-- el agente en la conversación.
alter table fincas_expedientes
  add column if not exists solicitante_nombre text not null default '',
  add column if not exists solicitante_tel    text not null default '',
  add column if not exists solicitante_email  text not null default '',
  add column if not exists cerrado_at         timestamptz;

-- Los presupuestos ahora entran por correo, no se inventan.
alter table fincas_presupuestos
  add column if not exists origen           text not null default 'manual',
  add column if not exists remitente_email  text not null default '',
  add column if not exists asunto           text not null default '',
  add column if not exists adjunto_path     text not null default '',
  add column if not exists adjunto_nombre   text not null default '',
  add column if not exists cuerpo           text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fincas_presupuestos_origen_chk') then
    alter table fincas_presupuestos
      add constraint fincas_presupuestos_origen_chk
      check (origen in ('manual', 'email'));
  end if;
end $$;

-- El importe deja de ser obligatorio: un presupuesto que entra por correo
-- puede llegar sin cifra legible hasta que alguien abre el PDF.
alter table fincas_presupuestos alter column importe drop not null;


-- =====================================================================
-- 5 · DOCUMENTOS Y NORMATIVA (el otro lado del RAG, también sin vectores)
-- =====================================================================
-- El PDF se guarda en Storage; el texto se extrae en el navegador del
-- administrador (pdf.js) y se guarda aquí para que el tsvector lo indexe.
-- Así el agente puede citar la normativa de ESA comunidad sin embeddings.
create table if not exists fincas_documentos (
  id           uuid primary key default gen_random_uuid(),
  comunidad_id uuid not null references fincas_comunidades(id) on delete cascade,
  tipo         text not null default 'normativa',
  titulo       text not null,
  archivo_path text not null default '',
  archivo_nombre text not null default '',
  texto        text not null default '',
  indexable    boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint fincas_documentos_tipo_chk
    check (tipo in ('normativa', 'acta', 'contrato', 'seguro', 'otro')),
  busqueda tsvector generated always as (
    to_tsvector('spanish', coalesce(titulo, '') || ' ' || coalesce(texto, ''))
  ) stored
);
create index if not exists fincas_documentos_comunidad_idx on fincas_documentos (comunidad_id);
create index if not exists fincas_documentos_busqueda_idx  on fincas_documentos using gin (busqueda);


-- =====================================================================
-- 6 · TIMELINE DE COMUNICACIONES
-- =====================================================================
-- Todo lo que sale y entra por el expediente: correos al proveedor,
-- respuestas, avisos internos. Es lo que hace auditable el "se avisó".
create table if not exists fincas_comunicaciones (
  id            uuid primary key default gen_random_uuid(),
  expediente_id uuid references fincas_expedientes(id) on delete cascade,
  comunidad_id  uuid references fincas_comunidades(id) on delete set null,
  direccion     text not null,
  canal         text not null default 'email',
  estado        text not null default 'enviado',
  de_email      text not null default '',
  para_email    text not null default '',
  asunto        text not null default '',
  cuerpo        text not null default '',
  adjuntos      jsonb not null default '[]'::jsonb,
  proveedor_id  uuid references fincas_proveedores(id) on delete set null,
  error         text not null default '',
  created_at    timestamptz not null default now(),
  constraint fincas_comunicaciones_direccion_chk
    check (direccion in ('saliente', 'entrante', 'interna')),
  constraint fincas_comunicaciones_canal_chk
    check (canal in ('email', 'telegram', 'sistema')),
  constraint fincas_comunicaciones_estado_chk
    check (estado in ('enviado', 'recibido', 'pendiente', 'fallido'))
);
create index if not exists fincas_comunicaciones_exp_idx on fincas_comunicaciones (expediente_id, created_at);


-- =====================================================================
-- 7 · FACTURACIÓN — SIEMPRE BORRADOR PRIMERO
-- =====================================================================
-- Facturas y certificados de deuda nacen en 'borrador' y no salen de ahí
-- sin que una persona los apruebe. Nada se emite solo.
create table if not exists fincas_facturas (
  id            uuid primary key default gen_random_uuid(),
  comunidad_id  uuid not null references fincas_comunidades(id) on delete cascade,
  inmueble_id   uuid references fincas_inmuebles(id) on delete set null,
  expediente_id uuid references fincas_expedientes(id) on delete set null,
  tipo          text not null default 'factura',
  numero        text not null default '',
  concepto      text not null,
  importe       numeric(12,2) not null default 0,
  periodo       text not null default '',
  detalle       jsonb not null default '[]'::jsonb,
  estado        text not null default 'borrador',
  decidido_por  text,
  decidido_at   timestamptz,
  motivo_rechazo text not null default '',
  created_at    timestamptz not null default now(),
  constraint fincas_facturas_tipo_chk
    check (tipo in ('factura', 'certificado_deuda')),
  constraint fincas_facturas_estado_chk
    check (estado in ('borrador', 'aprobada', 'rechazada'))
);
create index if not exists fincas_facturas_comunidad_idx on fincas_facturas (comunidad_id);
create index if not exists fincas_facturas_estado_idx    on fincas_facturas (estado);


-- =====================================================================
-- 8 · BÚSQUEDA — el filtro por comunidad sigue cableado
-- =====================================================================
-- Busca en la normativa de UNA comunidad. Mismo principio que
-- fincas_buscar_protocolo: si p_comunidad es nulo, la comparación es nula
-- y no salen filas. Falla cerrada.
create or replace function public.fincas_buscar_normativa(
  p_comunidad uuid,
  p_consulta  text
)
returns table (
  id uuid, comunidad_id uuid, titulo text, tipo text, extracto text
)
language sql
stable
set search_path = pg_catalog, public
as $$
  select d.id, d.comunidad_id, d.titulo, d.tipo,
         ts_headline('spanish', d.texto, plainto_tsquery('spanish', p_consulta),
                     'MaxWords=60, MinWords=25, MaxFragments=2, FragmentDelimiter=" … "')
  from fincas_documentos d
  where d.comunidad_id = p_comunidad
    and d.indexable
    and coalesce(btrim(p_consulta), '') <> ''
    and d.busqueda @@ plainto_tsquery('spanish', p_consulta)
  order by ts_rank(d.busqueda, plainto_tsquery('spanish', p_consulta)) desc
  limit 3;
$$;

-- Identificar la comunidad por lo que escribe el vecino ("Serrano 118",
-- "la de Brasil"). Devuelve SÓLO nombre y dirección: ni presidente, ni
-- IBAN — que además viven en otro esquema.
create or replace function public.fincas_buscar_comunidad(p_texto text)
returns table (id uuid, nombre text, direccion text)
language sql
stable
set search_path = pg_catalog, public
as $$
  select c.id, c.nombre, c.direccion
  from fincas_comunidades c
  where c.activa
    and coalesce(btrim(p_texto), '') <> ''
    and (c.nombre ilike '%' || btrim(p_texto) || '%'
      or c.direccion ilike '%' || btrim(p_texto) || '%')
  order by c.nombre
  limit 5;
$$;


-- =====================================================================
-- 9 · AUDITORÍA AUTOMÁTICA
-- =====================================================================
-- No se confía en que el cliente llame a nadie: el rastro lo deja la base.
-- Cualquier escritura sobre las tablas sensibles queda registrada, venga
-- del CRM (con el email del admin) o de una Edge Function (como 'servicio').
create or replace function public.fincas_auditar_cambio()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_detalle jsonb;
begin
  v_detalle := jsonb_build_object(
    'op', tg_op,
    'id', coalesce((to_jsonb(new) ->> 'id'), (to_jsonb(old) ->> 'id'))
  );

  -- Para los cambios de estado se guarda el antes y el después: es lo que
  -- se mira cuando alguien pregunta "¿quién aprobó esto?".
  if tg_op = 'UPDATE' then
    if (to_jsonb(old) ? 'estado') and (to_jsonb(old) ->> 'estado') is distinct from (to_jsonb(new) ->> 'estado') then
      v_detalle := v_detalle || jsonb_build_object(
        'estado_antes', to_jsonb(old) ->> 'estado',
        'estado_despues', to_jsonb(new) ->> 'estado'
      );
    end if;
  end if;

  if (to_jsonb(coalesce(new, old)) ? 'ref') then
    v_detalle := v_detalle || jsonb_build_object('ref', to_jsonb(coalesce(new, old)) ->> 'ref');
  end if;

  insert into fincas_auditoria (actor, accion, entidad, detalle)
  values (public.fincas_actor(), lower(tg_op), tg_table_name, v_detalle);

  return coalesce(new, old);
end;
$$;
revoke execute on function public.fincas_auditar_cambio() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'fincas_comunidades', 'fincas_proveedores', 'fincas_protocolos',
    'fincas_inmuebles', 'fincas_expedientes', 'fincas_presupuestos',
    'fincas_facturas', 'fincas_documentos'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_auditar', t);
    execute format(
      'create trigger %I after insert or update or delete on %I
         for each row execute function public.fincas_auditar_cambio()',
      t || '_auditar', t
    );
  end loop;
end $$;


-- =====================================================================
-- 10 · RLS ESTRICTA — anon deja de leer NADA
-- =====================================================================
-- En la demo anterior anon podía hacer SELECT de todo porque los datos
-- eran ficticios. Ahora hay IBAN, propietarios y facturación: se cierra.
-- El chat del vecino sigue funcionando porque no lee la base directamente;
-- habla con la Edge Function, que usa service role y sólo devuelve lo que
-- esa conversación necesita.
alter table fincas_perfiles            enable row level security;
alter table fincas_proveedor_comunidad enable row level security;
alter table fincas_documentos          enable row level security;
alter table fincas_comunicaciones      enable row level security;
alter table fincas_facturas            enable row level security;

do $$
declare t text;
begin
  -- Fuera las policies permisivas de la demo.
  foreach t in array array[
    'fincas_comunidades', 'fincas_inmuebles', 'fincas_proveedores',
    'fincas_protocolos', 'fincas_expedientes', 'fincas_presupuestos',
    'fincas_auditoria'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_select_demo', t);
  end loop;

  -- El equipo (perfil activo) lee y escribe. Nadie más, ni siquiera un
  -- usuario autenticado sin perfil.
  foreach t in array array[
    'fincas_comunidades', 'fincas_inmuebles', 'fincas_proveedores',
    'fincas_proveedor_comunidad', 'fincas_protocolos', 'fincas_expedientes',
    'fincas_presupuestos', 'fincas_facturas', 'fincas_documentos',
    'fincas_comunicaciones'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_staff', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (public.fincas_es_staff()) with check (public.fincas_es_staff())',
      t || '_staff', t
    );
  end loop;
end $$;

-- La auditoría se lee, no se toca. Ni el equipo puede escribir en ella a
-- mano: entra sola por los triggers, que corren como security definer.
drop policy if exists fincas_auditoria_staff_select on fincas_auditoria;
create policy fincas_auditoria_staff_select on fincas_auditoria
  for select to authenticated using (public.fincas_es_staff());

-- Cada cual ve su propio perfil (lo necesita fincas_es_staff), nada más.
drop policy if exists fincas_perfiles_propio on fincas_perfiles;
create policy fincas_perfiles_propio on fincas_perfiles
  for select to authenticated using (user_id = auth.uid());


-- =====================================================================
-- 11 · AUDITORÍA APPEND-ONLY DE VERDAD
-- =====================================================================
-- Ya estaba bloqueado UPDATE y DELETE. Ahora también TRUNCATE, que era el
-- agujero que este mismo fichero ha usado arriba para vaciarla.
create or replace function public.fincas_auditoria_no_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'fincas_auditoria es append-only: TRUNCATE no está permitido';
end;
$$;

drop trigger if exists fincas_auditoria_no_truncate on fincas_auditoria;
create trigger fincas_auditoria_no_truncate
  before truncate on fincas_auditoria
  for each statement execute function public.fincas_auditoria_no_truncate();


-- =====================================================================
-- 12 · REALTIME Y STORAGE
-- =====================================================================
alter table fincas_comunicaciones replica identity full;
alter table fincas_facturas       replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table fincas_comunicaciones;
  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table fincas_facturas;
  exception when duplicate_object then null; end;
end $$;

-- Bucket privado: normativa de comunidades y adjuntos de correo entrante.
insert into storage.buckets (id, name, public)
values ('fincas-docs', 'fincas-docs', false)
on conflict (id) do nothing;

drop policy if exists fincas_docs_staff on storage.objects;
create policy fincas_docs_staff on storage.objects
  for all to authenticated
  using (bucket_id = 'fincas-docs' and public.fincas_es_staff())
  with check (bucket_id = 'fincas-docs' and public.fincas_es_staff());
