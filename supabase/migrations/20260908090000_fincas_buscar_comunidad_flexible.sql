create or replace function public.fincas_buscar_comunidad(p_texto text)
returns table(id uuid, nombre text, direccion text)
language sql
stable
set search_path to 'pg_catalog','public'
as $function$
  with norm as (
    select translate(lower(btrim(coalesce(p_texto,''))),
                     'áàäâéèëêíìïîóòöôúùüûñç',
                     'aaaaeeeeiiiioooouuuunc') as t
  ),
  toks as (
    select distinct tok
    from norm, unnest(regexp_split_to_array(norm.t, '[^a-z0-9]+')) as tok
    where length(tok) >= 3
      and tok not in ('calle','avda','avenida','plaza','pza','paseo','camino','ctra',
                      'carretera','numero','num','piso','pta','puerta','esc','escalera',
                      'bajo','portal','bloque','edificio','urbanizacion','urb','comunidad',
                      'residencial','del','los','las','con','por','para','mza','manzana')
  )
  select c.id, c.nombre, c.direccion
  from fincas_comunidades c
  cross join lateral (
    select translate(lower(c.nombre || ' ' || c.direccion),
                     'áàäâéèëêíìïîóòöôúùüûñç',
                     'aaaaeeeeiiiioooouuuunc') as hay
  ) h
  where c.activa
    and (select count(*) from toks) > 0
    and (select count(*) from toks where h.hay like '%' || toks.tok || '%') > 0
  order by
    (select count(*) from toks where h.hay like '%' || toks.tok || '%') desc,
    c.nombre
  limit 5;
$function$;
