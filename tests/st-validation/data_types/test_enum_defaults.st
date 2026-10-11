TEST 'enumerated and named-value defaults'
  VAR uut : EnumDefaults; END_VAR
  uut();
  ASSERT_TRUE(uut.n = NV#NV_A);
  ASSERT_TRUE(uut.d = NVD#NVD_D);
  ASSERT_TRUE(uut.e = EN#EN_DOWN);
  ASSERT_TRUE(uut.given = NV#NV_B);
  ASSERT_TRUE(uut.na[1] = NV#NV_A);
  ASSERT_TRUE(uut.na[3] = NV#NV_A);
  ASSERT_TRUE(uut.da[1, 1] = NVD#NVD_D);
  ASSERT_TRUE(uut.da[2, 2] = NVD#NVD_D);
  ASSERT_TRUE(uut.ea[2] = EN#EN_DOWN);
  ASSERT_TRUE(uut.h.n = NV#NV_A);
  ASSERT_TRUE(uut.h.d = NVD#NVD_D);
  ASSERT_TRUE(uut.row[2] = NV#NV_A);
  ASSERT_TRUE(uut.fb.o = NV#NV_A);
  ASSERT_TRUE(uut.fb.oa[1] = NVD#NVD_D);
END_TEST
