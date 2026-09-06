-- =====================================================================
-- Whitemoon Fincas — autonomía por niveles, biblioteca de correos y
-- ampliación de facturas para el Contable IA
-- =====================================================================
-- Se AMPLÍAN las tablas del MVP, no se duplican: fincas_facturas ya existía
-- con su cola de aprobación y aquí sólo gana los campos contables;
-- fincas_comunicaciones ya era el timeline y aquí sólo gana el estado
-- 'borrador' para los correos que esperan visto bueno.
-- =====================================================================


-- =====================================================================
-- 1 · AUTONOMÍA POR NIVELES
-- =====================================================================
-- Global (comunidad_id nulo) con override por comunidad. Una comunidad
-- grande puede querer 1.000 € de margen y otra ninguno.
create table if not exists fincas_config_autonomia (
  id                 uuid primary key default gen_random_uuid(),
  comunidad_id       uuid references fincas_comunidades(id) on delete cascade,
  umbral_auto_eur    numeric(12,2) not null default 0,
  tramites_confianza jsonb not null default '[]'::jsonb,
  notas              text not null default '',
  actualizado_at     timestamptz not null default now(),
  actualizado_por    text not null default '',
  constraint fincas_config_umbral_chk check (umbral_auto_eur >= 0)
);

-- Una sola fila global y una sola por comunidad.
create unique index if not exists fincas_config_autonomia_global_idx
  on fincas_config_autonomia ((comunidad_id is null)) where comunidad_id is null;
create unique index if not exists fincas_config_autonomia_comunidad_idx
  on fincas_config_autonomia (comunidad_id) where comunidad_id is not null;

-- Fila global de arranque. Umbral 0 y ningún trámite de confianza: se
-- empieza cerrado. Que la máquina gaste dinero sola tiene que ser una
-- decisión explícita del administrador, no el valor por defecto.
insert into fincas_config_autonomia (comunidad_id, umbral_auto_eur, tramites_confianza, notas)
select null, 0, '[]'::jsonb,
       'Configuración global de arranque: nada automático que implique dinero.'
where not exists (select 1 from fincas_config_autonomia where comunidad_id is null);


-- =====================================================================
-- 2 · BIBLIOTECA DE CORREOS POR TRÁMITE
-- =====================================================================
-- El cuerpo lleva {{variables}} que rellena el CÓDIGO, no el modelo. El
-- agente elige QUÉ plantilla toca; el texto que sale es el que un humano
-- escribió y puede editar en el CRM.
create table if not exists fincas_plantillas_email (
  id            uuid primary key default gen_random_uuid(),
  tipo_tramite  text not null,
  comunidad_id  uuid references fincas_comunidades(id) on delete cascade,
  categoria     text not null default 'operativo',
  asunto        text not null,
  cuerpo        text not null,
  tono          text not null default 'cercano',
  activa        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint fincas_plantillas_categoria_chk
    check (categoria in ('operativo', 'dinero', 'legal'))
);

create unique index if not exists fincas_plantillas_global_idx
  on fincas_plantillas_email (tipo_tramite) where comunidad_id is null;
create unique index if not exists fincas_plantillas_comunidad_idx
  on fincas_plantillas_email (tipo_tramite, comunidad_id) where comunidad_id is not null;

-- Resuelve qué plantilla toca: la de la comunidad si existe, si no la global.
create or replace function public.fincas_plantilla(
  p_comunidad uuid,
  p_tramite   text
)
returns table (
  id uuid, tipo_tramite text, categoria text, asunto text, cuerpo text, tono text
)
language sql
stable
set search_path = pg_catalog, public
as $$
  select p.id, p.tipo_tramite, p.categoria, p.asunto, p.cuerpo, p.tono
  from fincas_plantillas_email p
  where p.tipo_tramite = p_tramite
    and p.activa
    and (p.comunidad_id = p_comunidad or p.comunidad_id is null)
  order by (p.comunidad_id is not null) desc
  limit 1;
$$;


-- =====================================================================
-- 3 · EL MOTOR DE DECISIÓN — en SQL, no en el prompt
-- =====================================================================
-- Aquí está la regla entera, en un sitio, legible y comprobable. El modelo
-- no participa: se le dice lo que ha decidido esta función, no al revés.
--
--   operativo sin dinero ............................ AUTO
--   dinero o legal .................................. REVISIÓN
--     ...salvo que el trámite esté marcado de confianza
--        Y el importe sea menor que el umbral ....... AUTO
--   cualquier otro caso (trámite desconocido, sin
--   configuración, importe nulo en un trámite de
--   dinero) ......................................... REVISIÓN
--
-- Falla cerrada a propósito: ante la duda, decide una persona.
create or replace function public.fincas_decidir_autonomia(
  p_comunidad uuid,
  p_tramite   text,
  p_importe   numeric default null
)
returns table (modo text, motivo text, categoria text, umbral numeric)
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_categoria text;
  v_umbral    numeric;
  v_confianza jsonb;
  v_es_confianza boolean;
begin
  select p.categoria into v_categoria
  from fincas_plantilla(p_comunidad, p_tramite) p;

  -- Trámite que no está en la biblioteca: no se sabe qué es, así que no se
  -- automatiza.
  if v_categoria is null then
    return query select 'revision'::text,
      'El trámite no está en la biblioteca de correos: lo revisa una persona.'::text,
      'desconocido'::text, 0::numeric;
    return;
  end if;

  select c.umbral_auto_eur, c.tramites_confianza
    into v_umbral, v_confianza
  from fincas_config_autonomia c
  where c.comunidad_id = p_comunidad or c.comunidad_id is null
  order by (c.comunidad_id is not null) desc
  limit 1;

  v_umbral := coalesce(v_umbral, 0);
  v_confianza := coalesce(v_confianza, '[]'::jsonb);
  v_es_confianza := v_confianza ? p_tramite;

  -- 1 · Operativo sin dinero de por medio.
  if v_categoria = 'operativo' and coalesce(p_importe, 0) = 0 then
    return query select 'auto'::text,
      'Trámite operativo sin importe: no compromete dinero.'::text,
      v_categoria, v_umbral;
    return;
  end if;

  -- 2 · La excepción: trámite de confianza por debajo del umbral.
  if v_es_confianza and p_importe is not null and p_importe < v_umbral then
    return query select 'auto'::text,
      format('Trámite de confianza y %s € por debajo del umbral de %s €.',
             to_char(p_importe, 'FM999999990.00'), to_char(v_umbral, 'FM999999990.00'))::text,
      v_categoria, v_umbral;
    return;
  end if;

  -- 3 · Todo lo demás lo decide una persona.
  return query select 'revision'::text,
    case
      when v_categoria <> 'operativo' and not v_es_confianza then
        format('Trámite de tipo "%s" y no está marcado como de confianza.', v_categoria)
      when p_importe is null then
        'No hay importe con el que comparar el umbral.'
      else
        format('%s € alcanza o supera el umbral de %s €.',
               to_char(p_importe, 'FM999999990.00'), to_char(v_umbral, 'FM999999990.00'))
    end::text,
    v_categoria, v_umbral;
end;
$$;


-- =====================================================================
-- 4 · FACTURAS — se amplía la tabla que ya existía
-- =====================================================================
alter table fincas_facturas
  add column if not exists proveedor_nombre text not null default '',
  add column if not exists fecha_factura    date,
  add column if not exists base             numeric(12,2),
  add column if not exists iva_porcentaje   numeric(5,2),
  add column if not exists iva_importe      numeric(12,2),
  add column if not exists total            numeric(12,2),
  add column if not exists discrepancias    jsonb not null default '[]'::jsonb,
  add column if not exists pdf_ref          text not null default '',
  add column if not exists pago_propuesto   jsonb not null default '{}'::jsonb,
  add column if not exists origen           text not null default 'manual';

-- `concepto` era obligatorio sin defecto: una factura extraída de un PDF
-- puede no traer un concepto claro y no debe reventar el alta por eso.
alter table fincas_facturas alter column concepto set default '';

-- 'revisar' es el estado que usa el Contable IA cuando algo no cuadra. No
-- es un rechazo ni una aprobación: es "mírate esto".
do $$
begin
  alter table fincas_facturas drop constraint if exists fincas_facturas_estado_chk;
  alter table fincas_facturas add constraint fincas_facturas_estado_chk
    check (estado in ('borrador', 'revisar', 'aprobada', 'rechazada'));
end $$;

create index if not exists fincas_facturas_proveedor_idx on fincas_facturas (proveedor_nombre);


-- =====================================================================
-- 5 · CORREOS EN BORRADOR — se amplía el timeline que ya existía
-- =====================================================================
-- Un correo que espera visto bueno es una comunicación más, sólo que
-- todavía no ha salido. Va en la misma tabla para que el historial del
-- expediente cuente la historia completa, incluida la parte de "esto se
-- redactó y aún no se ha mandado".
alter table fincas_comunicaciones
  add column if not exists tramite     text not null default '',
  add column if not exists plantilla_id uuid references fincas_plantillas_email(id) on delete set null,
  add column if not exists decision    jsonb not null default '{}'::jsonb,
  add column if not exists aprobado_por text not null default '';

do $$
begin
  alter table fincas_comunicaciones drop constraint if exists fincas_comunicaciones_estado_chk;
  alter table fincas_comunicaciones add constraint fincas_comunicaciones_estado_chk
    check (estado in ('borrador', 'enviado', 'recibido', 'pendiente', 'fallido'));
end $$;


-- =====================================================================
-- 6 · RLS Y AUDITORÍA DE LAS TABLAS NUEVAS
-- =====================================================================
alter table fincas_config_autonomia  enable row level security;
alter table fincas_plantillas_email  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['fincas_config_autonomia', 'fincas_plantillas_email'] loop
    execute format('drop policy if exists %I on %I', t || '_staff', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (public.fincas_es_staff()) with check (public.fincas_es_staff())',
      t || '_staff', t
    );
    execute format('drop trigger if exists %I on %I', t || '_auditar', t);
    execute format(
      'create trigger %I after insert or update or delete on %I
         for each row execute function public.fincas_auditar_cambio()',
      t || '_auditar', t
    );
  end loop;
end $$;

-- El timeline también se audita ahora: un correo que sale solo tiene que
-- dejar constancia de que salió solo.
drop trigger if exists fincas_comunicaciones_auditar on fincas_comunicaciones;
create trigger fincas_comunicaciones_auditar
  after insert or update on fincas_comunicaciones
  for each row execute function public.fincas_auditar_cambio();


-- =====================================================================
-- 7 · LA BIBLIOTECA DE ARRANQUE
-- =====================================================================
-- Los ocho trámites mínimos, en castellano y editables desde el CRM. No son
-- "datos de ejemplo": son la funcionalidad. Las variables {{...}} las
-- rellena el código con datos del expediente.
insert into fincas_plantillas_email (tipo_tramite, categoria, asunto, cuerpo, tono)
select * from (values

('solicitud_presupuesto', 'operativo',
 '[{{ref}}] Petición de presupuesto — {{comunidad}}',
 'Buenos días,

Os solicitamos presupuesto para la siguiente incidencia en {{comunidad}} ({{direccion}}):

Expediente: {{ref}}
Incidencia: {{tipo}} · {{subtipo}}
Urgencia: {{urgencia}}

{{descripcion}}

Respondiendo a este correo con el presupuesto adjunto, entra directamente en el expediente. Por favor, no cambiéis el asunto: la referencia {{ref}} es la que lo enlaza.

Un saludo,
{{administracion}}', 'formal'),

('recordatorio_presupuesto', 'operativo',
 '[{{ref}}] Recordatorio de presupuesto pendiente — {{comunidad}}',
 'Buenos días,

Os escribimos para recordaros que seguimos a la espera del presupuesto del expediente {{ref}} ({{tipo}} · {{subtipo}}) en {{comunidad}}.

Si necesitáis algún dato más para prepararlo, decídnoslo y os lo pasamos.

Un saludo,
{{administracion}}', 'cercano'),

('confirmacion_visita', 'operativo',
 '[{{ref}}] Confirmación de visita — {{comunidad}}',
 'Buenos días,

Confirmamos la visita para el expediente {{ref}} en {{comunidad}}, {{direccion}}{{puerta}}.

Contacto en la finca: {{solicitante}} · {{solicitante_tel}}

Si necesitáis cambiar la hora, avisadnos respondiendo a este correo.

Un saludo,
{{administracion}}', 'cercano'),

('adjudicacion', 'dinero',
 '[{{ref}}] Adjudicación de los trabajos — {{comunidad}}',
 'Buenos días,

Os confirmamos la adjudicación de los trabajos del expediente {{ref}} en {{comunidad}}, por el importe presupuestado de {{importe}}.

Incidencia: {{tipo}} · {{subtipo}}
{{descripcion}}

Rogamos confirméis la fecha prevista de intervención respondiendo a este correo.

Un saludo,
{{administracion}}', 'formal'),

('solicitud_factura', 'operativo',
 '[{{ref}}] Solicitud de factura — {{comunidad}}',
 'Buenos días,

Una vez finalizados los trabajos del expediente {{ref}} en {{comunidad}}, os solicitamos el envío de la factura correspondiente.

Por favor, indicad la referencia {{ref}} en la factura para que quede asociada al expediente.

Un saludo,
{{administracion}}', 'formal'),

('reclamacion_factura', 'dinero',
 '[{{ref}}] Discrepancia en la factura {{numero_factura}} — {{comunidad}}',
 'Buenos días,

Revisando la factura {{numero_factura}} correspondiente al expediente {{ref}} de {{comunidad}}, hemos detectado una discrepancia que necesitamos aclarar antes de tramitar el pago.

Importe facturado: {{importe}}

Quedamos a la espera de vuestra revisión o de una factura rectificativa.

Un saludo,
{{administracion}}', 'formal'),

('aviso_propietario', 'operativo',
 '[{{ref}}] Novedades sobre tu incidencia — {{comunidad}}',
 'Hola {{solicitante}},

Te escribimos sobre la incidencia que nos comunicaste en {{comunidad}} (expediente {{ref}}).

{{descripcion}}

Hemos dado aviso a {{proveedor}} y te mantendremos al tanto. Si necesitas cualquier cosa, responde a este correo.

Un saludo,
{{administracion}}', 'cercano'),

('apertura_siniestro', 'legal',
 '[{{ref}}] Apertura de parte de siniestro — {{comunidad}}',
 'Buenos días,

Comunicamos la apertura de parte de siniestro correspondiente al expediente {{ref}} de la comunidad {{comunidad}}, sita en {{direccion}}.

Fecha del siniestro: {{fecha}}
Naturaleza: {{tipo}} · {{subtipo}}
Descripción de los hechos: {{descripcion}}

Quedamos a la espera de la asignación de perito y del número de expediente de vuestra compañía.

Atentamente,
{{administracion}}', 'formal')

) as v(tipo_tramite, categoria, asunto, cuerpo, tono)
where not exists (
  select 1 from fincas_plantillas_email e
  where e.tipo_tramite = v.tipo_tramite and e.comunidad_id is null
);
