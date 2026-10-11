(* The default of an enumerated type and of a data type with named values
   (IEC 61131-3 6.4.4.2.2, 6.4.4.3.2): the type's own initial value when it
   has one, otherwise the first element of the list - for every variable of
   the type, array elements and structure elements included. *)
TYPE
  NV : USINT (NV_A := 5, NV_B := 7);
  NVD : USINT (NVD_C := 3, NVD_D := 9) := NVD_D;
  EN : (EN_UP, EN_DOWN) := EN_DOWN;
  HOLDER : STRUCT n : NV; d : NVD; END_STRUCT;
  NVROW : ARRAY[1..2] OF NV;
END_TYPE

FUNCTION_BLOCK EnumDefaultsFB
  VAR_OUTPUT o : NV; oa : ARRAY[0..1] OF NVD; END_VAR
END_FUNCTION_BLOCK

PROGRAM EnumDefaults
  VAR
    n : NV;
    d : NVD;
    e : EN;
    given : NV := NV_B;
    na : ARRAY[1..3] OF NV;
    da : ARRAY[1..2, 1..2] OF NVD;
    ea : ARRAY[1..2] OF EN;
    h : HOLDER;
    row : NVROW;
    fb : EnumDefaultsFB;
  END_VAR
  fb();
END_PROGRAM
