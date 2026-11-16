' Jarvis Studio: SolidWorks history export (JarvisHistoryExport.vbs)
'
' Double-click this file while SolidWorks (2015 or later) is running. For every part (.SLDPRT) and assembly (.SLDASM)
' in a folder and all its subfolders (or only the document open in SolidWorks) it writes, next to the file:
'   <name>.jarvis-sw.json   the feature history, sketches with relations and dimensions, references, mass properties
'                           and bounding box (parts); components, transforms and mates (assemblies)
'   <name>.jarvis-sw.log    what was read, and what could not be
' and one summary, JarvisExport-summary.txt, in the top folder. Jarvis Studio imports the .jarvis-sw.json files
' (File > Import) and rebuilds the parts as its own sketches and features.
'
' It only reads: every document is opened read-only and closed again without saving. Documents that were already
' open stay open. All numbers are SolidWorks system units (metres, radians, kilograms, as the API gives them) and are
' written with a dot, whatever the Windows number format. Transforms are MathTransform.ArrayData as SolidWorks gives
' them (9 rotation, 3 translation, 1 scale, 3 unused).

Option Explicit

Const TITLE = "Jarvis history export"
Const SCRIPT_VERSION = "1.0"
Const FORMAT_VERSION = 1
' Moves the rollback bar after each feature to measure the volume there: slower, but it tells Jarvis Studio exactly
' where a rebuild starts to differ. Set to False for a quicker run.
Const MEASURE_EACH_FEATURE = True
Const MAX_FACES_PER_FEATURE = 40
Const MAX_PATTERN_TRANSFORMS = 200
Const SUMMARY_NAME = "JarvisExport-summary.txt"

Dim swApp, fso, decSep
Dim gEval                 ' the object Eval reads properties of (see ReadValue)
Dim gLog, gLogCount       ' log lines of the document being exported
Dim gErrs, gErrCount      ' errors of the feature being exported
Dim gTypeNames            ' TypeName of each kind of object met, logged once per document
Dim gDoc                  ' the document being exported
Dim gSummaryPath
Dim gDone, gSkipped, gFailed

Main

Sub Main()
    Dim answer, top, outFolder, exportAll, files, i, n, active, path, started
    On Error Resume Next
    Set swApp = GetObject(, "SldWorks.Application")
    If Err.Number <> 0 Or Not IsObject(swApp) Then
        MsgBox "SolidWorks is not running." & vbCrLf & vbCrLf & "Start SolidWorks, then double-click this file again.", vbExclamation, TITLE
        Exit Sub
    End If
    Err.Clear
    Set fso = CreateObject("Scripting.FileSystemObject")
    decSep = Mid(CStr(0.5), 2, 1)
    ReDim gLog(63): gLogCount = 0
    ReDim gErrs(15): gErrCount = 0
    Set gTypeNames = CreateObject("Scripting.Dictionary")

    answer = MsgBox("Export a whole folder and all its subfolders?" & vbCrLf & vbCrLf _
        & "Yes: choose the top folder (for example Z:\3D_Prints). Every part and assembly in it gets its" & vbCrLf _
        & "<name>.jarvis-sw.json next to it." & vbCrLf & vbCrLf _
        & "No: export only the document open in SolidWorks.", vbYesNoCancel + vbQuestion, TITLE)
    If answer = vbCancel Then Exit Sub

    gDone = 0: gSkipped = 0: gFailed = 0
    started = Now
    If answer = vbNo Then
        Set active = swApp.ActiveDoc
        If Not HasObj(active) Then
            MsgBox "No document is open in SolidWorks.", vbExclamation, TITLE
            Exit Sub
        End If
        path = active.GetPathName
        If path = "" Then
            MsgBox "Save the document first: the export is written next to its file.", vbExclamation, TITLE
            Exit Sub
        End If
        gSummaryPath = fso.BuildPath(fso.GetParentFolderName(path), SUMMARY_NAME)
        Summary "Export of the open document " & path & " started " & Stamp(started)
        ExportFile path, "", True
        Summary "Finished " & Stamp(Now) & ": " & gDone & " done, " & gFailed & " failed."
        MsgBox "Done: " & fso.GetBaseName(path) & ".jarvis-sw.json" & vbCrLf & vbCrLf & ResultLine() & vbCrLf & vbCrLf _
            & "See " & gSummaryPath, vbInformation, TITLE
        Exit Sub
    End If

    top = PickFolder("Choose the top folder of your designs (every subfolder is exported too):")
    If top = "" Then Exit Sub
    outFolder = ""
    answer = MsgBox("Write each .jarvis-sw.json next to its part (recommended)?" & vbCrLf & vbCrLf _
        & "No: choose one folder for all of them.", vbYesNoCancel + vbQuestion, TITLE)
    If answer = vbCancel Then Exit Sub
    If answer = vbNo Then
        outFolder = PickFolder("Choose the folder to write all the .jarvis-sw.json files to:")
        If outFolder = "" Then Exit Sub
    End If
    answer = MsgBox("Export all parts again?" & vbCrLf & vbCrLf _
        & "Yes: export every part and assembly again." & vbCrLf _
        & "No: skip those whose .jarvis-sw.json is newer than the SolidWorks file.", vbYesNoCancel + vbQuestion, TITLE)
    If answer = vbCancel Then Exit Sub
    exportAll = (answer = vbYes)

    Set files = CreateObject("Scripting.Dictionary")
    CollectFiles fso.GetFolder(top), files
    n = files.Count
    If n = 0 Then
        MsgBox "There are no .SLDPRT or .SLDASM files in " & top, vbExclamation, TITLE
        Exit Sub
    End If
    gSummaryPath = fso.BuildPath(top, SUMMARY_NAME)
    answer = MsgBox("Found " & n & " SolidWorks files in " & top & "." & vbCrLf & vbCrLf _
        & "Export them now? SolidWorks is busy until it is done; a message appears at the end." & vbCrLf _
        & "Progress is written to " & gSummaryPath, vbOKCancel + vbInformation, TITLE)
    If answer <> vbOK Then Exit Sub

    Summary "Export of " & top & " started " & Stamp(started) & " (" & n & " files; " _
        & IIfStr(exportAll, "exporting all again", "skipping up-to-date ones") _
        & IIfStr(outFolder = "", "; written next to each file", "; written to " & outFolder) & ")"
    Dim names
    names = files.Keys
    For i = 0 To n - 1
        ExportFile names(i), outFolder, exportAll
    Next
    Summary "Finished " & Stamp(Now) & ": " & ResultLine()
    MsgBox "Export finished." & vbCrLf & vbCrLf & ResultLine() & vbCrLf & vbCrLf & "See " & gSummaryPath, vbInformation, TITLE
End Sub

Function ResultLine()
    ResultLine = gDone & " exported, " & gSkipped & " skipped (up to date), " & gFailed & " failed"
End Function

Function IIfStr(cond, a, b)
    If cond Then IIfStr = a Else IIfStr = b
End Function

Function Stamp(t)
    Stamp = Year(t) & "-" & Right("0" & Month(t), 2) & "-" & Right("0" & Day(t), 2) & " " _
        & Right("0" & Hour(t), 2) & ":" & Right("0" & Minute(t), 2) & ":" & Right("0" & Second(t), 2)
End Function

Function PickFolder(prompt)
    Dim shellApp, folder
    PickFolder = ""
    On Error Resume Next
    Set shellApp = CreateObject("Shell.Application")
    ' 1: file system folders only; &H10: an edit box to type a path such as Z:\3D_Prints; &H40: the newer dialog.
    Set folder = shellApp.BrowseForFolder(0, prompt, &H1 + &H10 + &H40, 0)
    If Err.Number <> 0 Then
        Err.Clear
        PickFolder = InputBox(prompt, TITLE, "Z:\3D_Prints")
        Exit Function
    End If
    If Not HasObj(folder) Then Exit Function
    PickFolder = folder.Self.Path
    If Err.Number <> 0 Or PickFolder = "" Then
        Err.Clear
        PickFolder = InputBox(prompt, TITLE, "Z:\3D_Prints")
    End If
End Function

Sub CollectFiles(folder, files)
    Dim f, sf, ext
    On Error Resume Next
    For Each f In folder.Files
        ext = LCase(fso.GetExtensionName(f.Name))
        If (ext = "sldprt" Or ext = "sldasm") And Left(f.Name, 2) <> "~$" Then
            If Not files.Exists(f.Path) Then files.Add f.Path, True
        End If
    Next
    If Err.Number <> 0 Then
        Summary "Could not list " & folder.Path & ": " & Err.Description
        Err.Clear
    End If
    For Each sf In folder.SubFolders
        CollectFiles sf, files
    Next
    Err.Clear
End Sub

' ---- One file -------------------------------------------------------------------------------------------------

Sub ExportFile(path, outFolder, exportAll)
    Dim ext, base, dir, jsonPath, logPath, kind, doc, spec, wasOpen, json, t0, why, partPath
    On Error Resume Next
    ext = LCase(fso.GetExtensionName(path))
    If ext = "sldasm" Then kind = 2 Else kind = 1
    base = fso.GetBaseName(path)
    If outFolder = "" Then dir = fso.GetParentFolderName(path) Else dir = outFolder
    jsonPath = fso.BuildPath(dir, base & ".jarvis-sw.json")
    logPath = fso.BuildPath(dir, base & ".jarvis-sw.log")
    If Not exportAll And fso.FileExists(jsonPath) Then
        If fso.GetFile(jsonPath).DateLastModified > fso.GetFile(path).DateLastModified Then
            gSkipped = gSkipped + 1
            Summary "skipped (up to date)  " & path
            Exit Sub
        End If
    End If
    Err.Clear

    t0 = Timer
    ReDim gLog(63): gLogCount = 0
    Set gTypeNames = CreateObject("Scripting.Dictionary")
    LogLine "Jarvis history export " & SCRIPT_VERSION & ", SolidWorks " & swApp.RevisionNumber & ", " & Stamp(Now)
    LogLine "File " & path

    ' Already open documents are used as they are and left open.
    wasOpen = False
    Set doc = swApp.GetOpenDocumentByName(path)
    If HasObj(doc) Then wasOpen = True
    Err.Clear
    If Not wasOpen Then
        Set doc = Nothing
        Set spec = swApp.GetOpenDocSpec(path)
        If HasObj(spec) Then
            spec.ReadOnly = True
            spec.Silent = True
            spec.DocumentType = kind
            Set doc = swApp.OpenDoc7(spec)
            If Not HasObj(doc) Then
                why = "SolidWorks could not open it (load error " & spec.Error & ", warning " & spec.Warning & ")"
            End If
        Else
            why = "SolidWorks gave no open specification (" & Err.Description & ")"
        End If
        Err.Clear
    End If
    If Not HasObj(doc) Then
        If why = "" Then why = "SolidWorks could not open it"
        gFailed = gFailed + 1
        Summary "FAILED  " & path & ": " & why
        LogLine "Failed: " & why
        WriteText logPath, LogText()
        Exit Sub
    End If
    Set gDoc = doc
    If doc.GetType = 2 Then kind = 2 Else kind = 1

    If kind = 2 Then
        json = AssemblyJson(doc, path)
    Else
        json = PartJson(doc, path)
    End If
    If Err.Number <> 0 Then
        LogLine "Error while exporting: " & Err.Description
        Err.Clear
    End If

    If Not wasOpen Then
        swApp.CloseDoc doc.GetTitle
        Err.Clear
        If HasObj(swApp.GetOpenDocumentByName(path)) Then swApp.CloseDoc path
        Err.Clear
    End If
    Set gDoc = Nothing

    LogLine "Took " & Num(Round(Timer - t0, 1)) & " s"
    If json = "" Then
        gFailed = gFailed + 1
        Summary "FAILED  " & path & ": nothing could be read (see " & logPath & ")"
        WriteText logPath, LogText()
        Exit Sub
    End If
    ' The log goes into the JSON too, so one file says everything.
    json = Left(json, Len(json) - 1) & ",""log"":" & LogArray() & "}"
    If WriteText(jsonPath & ".part", json) Then
        If fso.FileExists(jsonPath) Then fso.DeleteFile jsonPath, True
        fso.MoveFile jsonPath & ".part", jsonPath
    End If
    If Err.Number <> 0 Or Not fso.FileExists(jsonPath) Then
        gFailed = gFailed + 1
        Summary "FAILED  " & path & ": could not write " & jsonPath & " (" & Err.Description & ")"
        Err.Clear
        WriteText logPath, LogText()
        Exit Sub
    End If
    WriteText logPath, LogText()
    gDone = gDone + 1
    Summary "done  " & path & "  (" & Num(Round(Timer - t0, 1)) & " s" & ErrorNote() & ")"
End Sub

Function ErrorNote()
    Dim i, k
    k = 0
    For i = 0 To gLogCount - 1
        If InStr(gLog(i), "could not") > 0 Or InStr(gLog(i), "Error") > 0 Then k = k + 1
    Next
    If k > 0 Then ErrorNote = ", " & k & " notes in the log" Else ErrorNote = ""
End Function

' ---- Part -------------------------------------------------------------------------------------------------------

Function PartJson(doc, path)
    Dim b, feat, list, n, i, after, conf, mp, bodies, body, j, box, tbox, vol
    On Error Resume Next
    Set b = New Buf
    b.Add "{""format"":""jarvis-sw-history"",""version"":" & FORMAT_VERSION & ",""kind"":""part"","
    b.Add """units"":{""length"":""m"",""angle"":""rad"",""area"":""m^2"",""volume"":""m^3"",""mass"":""kg""},"
    b.Add """transforms"":""MathTransform.ArrayData: 9 rotation, 3 translation, 1 scale, 3 unused"","
    b.Add """exporter"":{""script"":""JarvisHistoryExport.vbs"",""version"":" & JStr(SCRIPT_VERSION) & ",""solidworks"":" & JStr(swApp.RevisionNumber) & ",""date"":" & JStr(Stamp(Now)) & "},"
    conf = ""
    conf = doc.ConfigurationManager.ActiveConfiguration.Name
    Err.Clear
    b.Add """document"":{""file"":" & JStr(fso.GetFileName(path)) & ",""path"":" & JStr(path) & ",""title"":" & JStr(doc.GetTitle) & ",""configuration"":" & JStr(conf) & "},"
    Err.Clear

    ' Mass properties and boxes of the finished part.
    b.Add """mass"":" & MassJson(doc) & ","
    Set box = New Box3: Set tbox = New Box3
    b.Add """bodies"":["
    bodies = doc.GetBodies2(0, False)
    If Err.Number <> 0 Then LogLine "GetBodies2 could not be read: " & Err.Description: Err.Clear
    j = 0
    If IsArray(bodies) Then
        For Each body In bodies
            If HasObj(body) Then
                If j > 0 Then b.Add ","
                b.Add BodyJson(body, box, tbox)
                j = j + 1
            End If
        Next
    End If
    b.Add "],"
    b.Add """box"":" & box.Json & ",""tessBox"":" & tbox.Json & ","

    ' Features in tree order; the sketches a feature uses come just before it.
    Set list = CollectFeatures(doc)
    n = list.Count
    LogLine n & " features"
    Set after = CreateObject("Scripting.Dictionary")
    If MEASURE_EACH_FEATURE Then MeasureAfterEach doc, list, after

    b.Add """features"":["
    For i = 0 To n - 1
        If i > 0 Then b.Add ","
        b.Add FeatureJson(doc, list.Item(i), after)
    Next
    b.Add "]}"
    PartJson = b.Text
End Function

Function MassJson(doc)
    Dim mp, c, s
    On Error Resume Next
    Set mp = doc.Extension.CreateMassProperty
    If Not HasObj(mp) Then
        LogLine "Mass properties could not be read: " & Err.Description
        Err.Clear
        MassJson = "null"
        Exit Function
    End If
    c = mp.CenterOfMass
    s = "{""volume"":" & Num(mp.Volume) & ",""area"":" & Num(mp.SurfaceArea) & ",""centre"":" & NumArr(c, 0, 3) _
        & ",""mass"":" & Num(mp.Mass) & ",""density"":" & Num(mp.Density) & "}"
    If Err.Number <> 0 Then LogLine "Mass properties: " & Err.Description: Err.Clear
    MassJson = s
End Function

Function BodyJson(body, box, tbox)
    Dim mp, bb, own, ownT, s, nm
    On Error Resume Next
    nm = body.Name
    mp = body.GetMassProperties(CDbl(1))
    bb = body.GetBodyBox
    Set own = New Box3
    Set ownT = New Box3
    If IsArray(bb) Then
        own.AddCorners bb
        box.AddCorners bb
    End If
    TessBoxOfBody body, ownT
    tbox.AddBox ownT
    s = "{""name"":" & JStr(nm) & ",""type"":" & Num(body.GetType)
    If IsArray(mp) Then s = s & ",""volume"":" & Num(mp(3)) & ",""area"":" & Num(mp(4)) & ",""centre"":" & NumArr(mp, 0, 3)
    s = s & ",""box"":" & own.Json & ",""tessBox"":" & ownT.Json & "}"
    If Err.Number <> 0 Then LogLine "Body " & nm & ": " & Err.Description: Err.Clear
    BodyJson = s
End Function

' The box of the display triangles: inside the true box, as SolidWorks' own boxes are outside it.
Sub TessBoxOfBody(body, box)
    Dim faces, face, t, i
    On Error Resume Next
    faces = body.GetFaces
    If Not IsArray(faces) Then Exit Sub
    For Each face In faces
        t = face.GetTessTriangles(True)
        If IsArray(t) Then
            For i = LBound(t) To UBound(t) - 2 Step 3
                box.AddPoint CDbl(t(i)), CDbl(t(i + 1)), CDbl(t(i + 2))
            Next
        End If
    Next
    Err.Clear
End Sub

' Top-level features in tree order, each sketch sub-feature written just before the feature that uses it.
Function CollectFeatures(doc)
    Dim list, seen, feat
    On Error Resume Next
    Set list = CreateObject("Scripting.Dictionary")
    Set seen = CreateObject("Scripting.Dictionary")
    Set feat = doc.FirstFeature
    Do While HasObj(feat)
        AddFeature feat, list, seen
        Set feat = feat.GetNextFeature
        If Err.Number <> 0 Then LogLine "GetNextFeature: " & Err.Description: Err.Clear: Exit Do
    Loop
    Set CollectFeatures = list
End Function

Sub AddFeature(feat, list, seen)
    Dim nm, sub1, t
    On Error Resume Next
    nm = feat.Name
    If seen.Exists(nm) Then Exit Sub
    seen.Add nm, True
    Set sub1 = feat.GetFirstSubFeature
    Do While HasObj(sub1)
        t = sub1.GetTypeName2
        If t = "ProfileFeature" Or t = "3DProfileFeature" Then AddFeature sub1, list, seen
        Set sub1 = sub1.GetNextSubFeature
    Loop
    Err.Clear
    list.Add list.Count, feat
End Sub

' Features that change no solid: nothing to measure after them.
Function NoGeometry(t)
    Select Case t
        Case "ProfileFeature", "3DProfileFeature", "RefPlane", "RefAxis", "RefPoint", "CoordSys", "OriginProfileFeature", _
             "CommentsFolder", "FavoriteFolder", "HistoryFolder", "SelectionSetFolder", "SensorFolder", "DocsFolder", _
             "DetailCabinet", "SurfaceBodyFolder", "SolidBodyFolder", "EnvFolder", "EqnFolder", "MaterialFolder", _
             "FtrFolder", "CosmeticThread", "MateReferenceGroupFolder", "ProfileFtrFolder", "RefPlaneFtrFolder", _
             "RefAxisFtrFolder", "BlockFolder", "CutListFolder", "Attribute", "LiveSection", "AmbientLight", _
             "DirectionLight", "PointLight", "SpotLight", "CameraFeature", "Configuration", "PartConfiguration"
            NoGeometry = True
        Case Else
            NoGeometry = False
    End Select
End Function

' Volume, area and body count after each feature, by moving the rollback bar to just after it.
Sub MeasureAfterEach(doc, list, after)
    Dim fm, i, feat, t, nm, ok, k
    On Error Resume Next
    Set fm = doc.FeatureManager
    If Not HasObj(fm) Then LogLine "FeatureManager could not be read: volumes after each feature are left out": Err.Clear: Exit Sub
    k = 0
    For i = 0 To list.Count - 1
        Set feat = list.Item(i)
        t = feat.GetTypeName2
        nm = feat.Name
        If Not NoGeometry(t) Then
            ok = fm.EditRollback(CLng(4), CStr(nm))
            If Err.Number <> 0 Or Not ok Then
                LogLine "Rollback to after " & nm & " could not be done (" & Err.Description & ")"
                Err.Clear
            Else
                after.Item(nm) = MeasureNow(doc)
                k = k + 1
            End If
        End If
    Next
    fm.EditRollback CLng(1), ""
    If Err.Number <> 0 Then LogLine "Rollback to the end: " & Err.Description: Err.Clear
    LogLine "Measured the volume after " & k & " features"
End Sub

Function MeasureNow(doc)
    Dim bodies, body, mp, vol, area, n, box
    On Error Resume Next
    vol = 0: area = 0: n = 0
    Set box = New Box3
    bodies = doc.GetBodies2(0, False)
    If IsArray(bodies) Then
        For Each body In bodies
            If HasObj(body) Then
                mp = body.GetMassProperties(CDbl(1))
                If IsArray(mp) Then vol = vol + mp(3): area = area + mp(4)
                box.AddCorners body.GetBodyBox
                n = n + 1
            End If
        Next
    End If
    Err.Clear
    MeasureNow = "{""volume"":" & Num(vol) & ",""area"":" & Num(area) & ",""bodies"":" & n & ",""box"":" & box.Json & "}"
End Function

' ---- One feature ----------------------------------------------------------------------------------------------------

Function FeatureJson(doc, feat, after)
    Dim s, t, t1, nm, sup, arr, p, sub1, k, data, kind, spec
    On Error Resume Next
    ReDim gErrs(15): gErrCount = 0
    nm = feat.Name
    t = feat.GetTypeName2
    t1 = feat.GetTypeName
    Err.Clear
    s = "{""name"":" & JStr(nm) & ",""type"":" & JStr(t)
    If t1 <> t And t1 <> "" Then s = s & ",""baseType"":" & JStr(t1)
    s = s & ",""id"":" & Num(feat.GetID)
    Err.Clear
    sup = False
    arr = feat.IsSuppressed2(CLng(1), Empty)
    If Err.Number = 0 And IsArray(arr) Then
        sup = CBool(arr(LBound(arr)))
    Else
        Err.Clear
        sup = CBool(feat.IsSuppressed)
    End If
    Err.Clear
    s = s & ",""suppressed"":" & JBool(sup)
    If NoGeometry(t) And t <> "RefPlane" And t <> "RefAxis" And t <> "RefPoint" And t <> "ProfileFeature" _
        And t <> "3DProfileFeature" And t <> "CosmeticThread" And t <> "CoordSys" Then
        FeatureJson = s & "}"
        Exit Function
    End If

    ' Parents and sub-features, by name.
    arr = feat.GetParents
    s = s & ",""parents"":" & FeatureNames(arr)
    Err.Clear
    s = s & ",""subFeatures"":["
    k = 0
    Set sub1 = feat.GetFirstSubFeature
    Do While HasObj(sub1)
        If k > 0 Then s = s & ","
        s = s & "{""name"":" & JStr(sub1.Name) & ",""type"":" & JStr(sub1.GetTypeName2) & "}"
        k = k + 1
        Set sub1 = sub1.GetNextSubFeature
    Loop
    s = s & "]"
    Err.Clear
    If after.Exists(nm) Then s = s & ",""after"":" & after.Item(nm)

    kind = FeatureKind(t, t1)
    Select Case kind
        Case "sketch"
            s = s & ",""sketch"":" & SketchJson(feat)
        Case "refPlane"
            Set spec = feat.GetSpecificFeature2
            s = s & ",""plane"":{""transform"":" & TransformJson(spec.Transform) & "}"
            Err.Clear
            s = s & ",""data"":" & DataJson(doc, feat, "Type,Type2,Distance,Angle,ReverseDirection,GetSelectionsCount,UseNormalPlane,SolutionIndex,AutoSize," _
                & "Constraint(0),Constraint(1),Constraint(2),AngleOrDistance(0),AngleOrDistance(1),AngleOrDistance(2)", _
                "Selections,Reference(0),Reference(1),Reference(2)")
        Case "refAxis"
            Set spec = feat.GetSpecificFeature2
            s = s & ",""axis"":{""params"":" & NumArr(spec.GetRefAxisParams, 0, 6) & "}"
            Err.Clear
            s = s & ",""data"":" & DataJson(doc, feat, "Type,GetSelectionsCount", "")
        Case "refPoint"
            Set spec = feat.GetSpecificFeature2
            s = s & ",""point"":{""at"":" & NumArr(spec.GetRefPoint.ArrayData, 0, 3) & "}"
            Err.Clear
            s = s & ",""data"":" & DataJson(doc, feat, "Type,Distance,AlongCurveOption,GetSelectionsCount", "Selections")
        Case "extrude"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "IsBossFeature,IsThinFeature,BothDirections,ReverseDirection,FlipSideToCut,FromType,FromOffsetDistance,FromOffsetReverse," _
                & "Merge,FeatureScope,AutoSelect,ThinWallType,CapEnds,CapThickness,GetContoursCount," _
                & "GetEndCondition(True),GetEndCondition(False),GetDepth(True),GetDepth(False)," _
                & "GetDraftWhileExtruding(True),GetDraftWhileExtruding(False),GetDraftAngle(True),GetDraftAngle(False)," _
                & "GetDraftOutward(True),GetDraftOutward(False),GetReverseOffset(True),GetReverseOffset(False)," _
                & "GetTranslateSurface(True),GetTranslateSurface(False),GetWallThickness(True),GetWallThickness(False)", _
                "Contours,FeatureScopeBodies")
            s = s & ",""ends"":" & ExtrudeEnds(doc, feat)
            s = s & ",""faces"":" & FeatureFaces(feat)
        Case "revolve"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "IsBossFeature,IsThinFeature,Type,ReverseDirection,Merge,GetRevolutionAngle(True),GetRevolutionAngle(False)," _
                & "GetAxisType,GetContoursCount,ThinWallType,GetWallThickness(True),GetWallThickness(False)", "Axis,Contours")
            s = s & ",""faces"":" & FeatureFaces(feat)
        Case "fillet"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "Type,DefaultRadius,IsMultipleRadius,PropagateToTangentFaces,AsymmetricFillet,DefaultDistance,ConicTypeForCrossSectionProfile," _
                & "DefaultConicRhoOrRadius,FilletItemsCount,RoundCorners,KeepFeatures,OverflowType,CurvatureContinuous,ConstantWidth," _
                & "GetEdgeCount,GetFaceCount,GetFeatureCount,GetLoopCount", _
                "Edges,GetFaces(0),GetFaces(1),GetFaces(2),Features,Loops")
            s = s & ",""items"":" & FilletItems(doc, feat)
        Case "chamfer"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "Type,EqualDistance,EdgeChamferAngle,GetEdgeChamferDistance(0),GetEdgeChamferDistance(1),GetIsFlipped,TangentPropagation," _
                & "GetVertexChamferDistance(0),GetVertexChamferDistance(1),GetVertexChamferDistance(2),GetEdgeCount,GetFaceCount,LoopCount,KeepFeatures", _
                "Edges,Faces,Loops,Vertex")
        Case "holeWizard"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "Type,Standard2,FastenerType2,FastenerSize,EndCondition,Depth,Diameter,HoleDepth,HoleDiameter,DrillAngle," _
                & "CounterBoreDiameter,CounterBoreDepth,CounterSinkDiameter,CounterSinkAngle,CounterDrillDiameter,CounterDrillDepth,CounterDrillAngle," _
                & "TapDrillDiameter,TapDrillDepth,ThreadDiameter,ThreadDepth,ThreadAngle,ThruHoleDiameter,ThruHoleDepth," _
                & "ThruTapDrillDiameter,ThruTapDrillDepth,MajorDiameter,MinorDiameter," _
                & "NearSideCounterSink,NearCounterSinkDiameter,NearCounterSinkAngle,FarSideCounterSink,FarCounterSinkDiameter,FarCounterSinkAngle," _
                & "MidCounterSinkDiameter,MidCounterSinkAngle,HeadClearance,HeadClearanceType,OffsetDistance,ReverseDirection," _
                & "ThreadEndCondition,CosmeticThreadType,HoleFit,Length,GetSketchPointCount", _
                "GetSketchPoints,Face,Vertex")
            s = s & ",""faces"":" & FeatureFaces(feat)
        Case "simpleHole"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "Type,Depth,Diameter,DraftAngle,DraftOutward,DraftWhileExtruding,ReverseDirection,ReverseOffset,SurfaceOffset,TranslateSurface", _
                "Face,Vertex")
            s = s & ",""faces"":" & FeatureFaces(feat)
        Case "linearPattern"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "BodyPattern,D1ReverseDirection,D1Spacing,D1TotalInstances,D2ReverseDirection,D2Spacing,D2TotalInstances,D2PatternSeedOnly," _
                & "GeometryPattern,VarySketch,IsDirection2Specified,GetD1AxisType,GetD2AxisType,GetPatternFeatureCount,GetPatternBodyCount," _
                & "GetSkippedItemCount,SkippedItemArray", _
                "D1Axis,D2Axis,PatternFeatureArray,PatternBodyArray,PatternFaceArray")
            s = s & ",""instances"":" & PatternTransforms(feat, "linear")
        Case "circularPattern"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "BodyPattern,EqualSpacing,GeometryPattern,ReverseDirection,Spacing,TotalInstances,VarySketch,GetAxisType," _
                & "GetPatternFeatureCount,GetPatternBodyCount,GetSkippedItemCount,SkippedItemArray", _
                "Axis,PatternFeatureArray,PatternBodyArray,PatternFaceArray")
            s = s & ",""instances"":" & PatternTransforms(feat, "circular")
        Case "mirror"
            s = s & ",""data"":" & DataJson(doc, feat, "GeometryPattern,GetMirrorPlaneType,GetPatternFeatureCount,GetMirrorFaceCount", _
                "Plane,PatternFeatureArray,MirrorFaceArray")
        Case "mirrorBody"
            s = s & ",""data"":" & DataJson(doc, feat, "Merge,KnitSurface,GetPatternBodyCount", "Face,PatternBodyArray")
            Set data = feat.GetDefinition
            s = s & ",""transform"":" & TransformJson(data.GetTransform)
            Set data = Nothing
            Err.Clear
        Case "shell"
            s = s & ",""data"":" & DataJson(doc, feat, "Thickness,Direction,FacesRemovedCount,GetMultipleThicknessFacesCount", _
                "FacesRemoved,MultipleThicknessFaces")
        Case "loft"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "IsBossFeature,IsThinFeature,Close,StartTangencyType,EndTangencyType,StartTangentLength,EndTangentLength,MaintainTangency," _
                & "AdvancedSmoothing,Merge,NumberOfSections,GetProfileCount,GetGuideCurvesCount,GuideCurveInfluence,ThinWallType", _
                "Profiles,GuideCurves,Centerline")
        Case "sweep"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "IsBossFeature,IsThinFeature,PathAlignmentType,TwistControlType,GetTwistAngle,MaintainTangency,MergeSmoothFaces," _
                & "AlignWithEndFaces,StartTangencyType,EndTangencyType,GetPathType,GetCutSweepOption,GetGuideCurvesCount,Merge,ThinWallType", _
                "Profile,Path,GuideCurves")
        Case "draft"
            s = s & ",""data"":" & DataJson(doc, feat, "Type,Angle,ReverseDirection,FacePropagation,StepType,GetFacesToDraftCount,AllowReducedAngle", _
                "NeutralPlane,FacesToDraft,DirectionPull,PartingLines")
        Case "rib"
            s = s & ",""data"":" & DataJson(doc, feat, _
                "Thickness,Type,IsTwoSided,FlipSide,ReverseThicknessDir,ExtrusionDirection,EnableDraft,DraftAngle,DraftOutward,DraftFromWall,RefSketchIndex", "")
        Case "cosmeticThread"
            s = s & ",""data"":" & DataJson(doc, feat, "ApplyThread,BlindDepth,Diameter,DiameterType,EndCondition,Size,Standard,StandardType,ThreadCallout", _
                "Edge,StartFromFacePlane")
    End Select
    s = s & ",""errors"":" & ErrsJson() & "}"
    FeatureJson = s
End Function

' What the feature is, from its type names (an Instant3D feature reports ICE from GetTypeName2; GetTypeName gives the real one).
Function FeatureKind(t, t1)
    Dim x
    x = t
    If x = "ICE" Then x = t1
    Select Case x
        Case "ProfileFeature", "3DProfileFeature": FeatureKind = "sketch"
        Case "RefPlane": FeatureKind = "refPlane"
        Case "RefAxis": FeatureKind = "refAxis"
        Case "RefPoint": FeatureKind = "refPoint"
        Case "Extrusion", "Boss", "BossThin", "Cut", "CutThin", "ICE", "Extrude": FeatureKind = "extrude"
        Case "Revolution", "RevolutionThin", "RevCut": FeatureKind = "revolve"
        Case "Fillet": FeatureKind = "fillet"
        Case "Chamfer": FeatureKind = "chamfer"
        Case "HoleWzd", "AdvHoleWzd": FeatureKind = "holeWizard"
        Case "HoleSimple", "SimpleHole", "Hole": FeatureKind = "simpleHole"
        Case "LPattern": FeatureKind = "linearPattern"
        Case "CirPattern": FeatureKind = "circularPattern"
        Case "MirrorPattern": FeatureKind = "mirror"
        Case "MirrorSolid": FeatureKind = "mirrorBody"
        Case "Shell": FeatureKind = "shell"
        Case "Blend", "BlendCut": FeatureKind = "loft"
        Case "Sweep", "SweepCut": FeatureKind = "sweep"
        Case "Draft": FeatureKind = "draft"
        Case "Rib": FeatureKind = "rib"
        Case "CosmeticThread": FeatureKind = "cosmeticThread"
        Case Else: FeatureKind = ""
    End Select
End Function

' Reads the feature data: the plain values first, then, with access to the feature's selections (SolidWorks rolls the
' model back to just before the feature meanwhile), the entities it uses, as points and normals.
Function DataJson(doc, feat, plain, selections)
    Dim data, s, names, i, ok, k
    On Error Resume Next
    Set data = feat.GetDefinition
    If Not HasObj(data) Then
        AddErr "GetDefinition: " & Err.Description
        Err.Clear
        DataJson = "null"
        Exit Function
    End If
    Note "feature data", data
    s = "{""object"":" & JStr(TypeName(data))
    k = 0
    If plain <> "" Then
        names = Split(plain, ",")
        For i = 0 To UBound(names)
            s = s & "," & JStr(names(i)) & ":" & ReadValue(data, names(i))
        Next
    End If
    If selections <> "" Then
        ok = data.AccessSelections(doc, Nothing)
        If Err.Number <> 0 Or Not ok Then
            AddErr "AccessSelections: " & Err.Description
            Err.Clear
        End If
        names = Split(selections, ",")
        For i = 0 To UBound(names)
            s = s & "," & JStr(names(i)) & ":" & ReadValue(data, names(i))
        Next
        data.ReleaseSelectionAccess
        Err.Clear
    End If
    Set data = Nothing
    DataJson = s & "}"
End Function

' One property or method of an object, by name (with arguments, e.g. "GetDepth(True)"), as JSON; an error is noted and
' gives null.
Function ReadValue(obj, expr)
    Dim v, isObj
    On Error Resume Next
    Set gEval = obj
    isObj = False
    Err.Clear
    Set v = Eval("gEval." & expr)
    If Err.Number = 0 Then
        isObj = True
    Else
        Err.Clear
        Set gEval = obj
        v = Eval("gEval." & expr)
    End If
    If Err.Number <> 0 Then
        AddErr expr & ": " & Err.Description
        Err.Clear
        ReadValue = "null"
        Exit Function
    End If
    If isObj Then
        ReadValue = EntityJson(v)
    Else
        ReadValue = ValueJson(v)
    End If
End Function

Function ValueJson(v)
    Dim s, x, k
    On Error Resume Next
    If IsArray(v) Then
        s = "["
        k = 0
        For Each x In v
            If k > 0 Then s = s & ","
            If IsObject(x) Then s = s & EntityJson(x) Else s = s & ValueJson(x)
            k = k + 1
        Next
        ValueJson = s & "]"
        Exit Function
    End If
    If IsObject(v) Then ValueJson = EntityJson(v): Exit Function
    Select Case VarType(v)
        Case 0, 1: ValueJson = "null"
        Case 11: ValueJson = JBool(v)
        Case 8: ValueJson = JStr(v)
        Case 2, 3, 4, 5, 6, 14, 17, 20: ValueJson = Num(v)
        Case Else: ValueJson = JStr(CStr(v))
    End Select
End Function

' ---- Entities: faces, edges and vertices as points on them (and normals), features and sketch items by name or id --

Function EntityKind(ent)
    Dim tn, x
    EntityKind = ""
    If Not HasObj(ent) Then Exit Function
    tn = LCase(TypeName(ent))
    If InStr(tn, "refplane") > 0 Then EntityKind = "refPlane": Exit Function
    If InStr(tn, "refaxis") > 0 Then EntityKind = "refAxis": Exit Function
    If InStr(tn, "refpoint") > 0 Then EntityKind = "refPoint": Exit Function
    If InStr(tn, "feature") > 0 Then EntityKind = "feature": Exit Function
    If InStr(tn, "surface") > 0 Then EntityKind = "surface": Exit Function
    If InStr(tn, "face") > 0 Then EntityKind = "face": Exit Function
    If InStr(tn, "edge") > 0 Then EntityKind = "edge": Exit Function
    If InStr(tn, "vertex") > 0 Then EntityKind = "vertex": Exit Function
    If InStr(tn, "loop") > 0 Then EntityKind = "loop": Exit Function
    If InStr(tn, "sketchcontour") > 0 Then EntityKind = "contour": Exit Function
    If InStr(tn, "sketchregion") > 0 Then EntityKind = "region": Exit Function
    If InStr(tn, "sketchpoint") > 0 Then EntityKind = "sketchPoint": Exit Function
    If InStr(tn, "sketch") > 0 And (InStr(tn, "segment") > 0 Or InStr(tn, "line") > 0 Or InStr(tn, "arc") > 0 _
        Or InStr(tn, "ellipse") > 0 Or InStr(tn, "spline") > 0 Or InStr(tn, "parabola") > 0) Then EntityKind = "sketchSegment": Exit Function
    If InStr(tn, "sketch") > 0 Then EntityKind = "sketch": Exit Function
    If InStr(tn, "component") > 0 Then EntityKind = "component": Exit Function
    If InStr(tn, "body") > 0 Then EntityKind = "body": Exit Function
    If InStr(tn, "dimension") > 0 Then EntityKind = "dimension": Exit Function
    ' The type name says nothing: try what each kind can do.
    On Error Resume Next
    Err.Clear: x = ent.GetTypeName2: If Err.Number = 0 Then EntityKind = "feature": Exit Function
    Err.Clear: x = ent.FaceInSurfaceSense: If Err.Number = 0 Then EntityKind = "face": Exit Function
    Err.Clear: x = ent.GetTwoAdjacentFaces2: If Err.Number = 0 Then EntityKind = "edge": Exit Function
    Err.Clear: x = ent.GetEdges: x = ent.GetPoint: If Err.Number = 0 Then EntityKind = "vertex": Exit Function
    Err.Clear: x = ent.GetSketchSegments: If Err.Number = 0 Then EntityKind = "contour": Exit Function
    Err.Clear: x = ent.ConstructionGeometry: If Err.Number = 0 Then EntityKind = "sketchSegment": Exit Function
    Err.Clear: x = ent.X: If Err.Number = 0 Then EntityKind = "sketchPoint": Exit Function
    Err.Clear: x = ent.GetRefAxisParams: If Err.Number = 0 Then EntityKind = "refAxis": Exit Function
    Err.Clear: x = ent.CornerPoints: If Err.Number = 0 Then EntityKind = "refPlane": Exit Function
    Err.Clear: x = ent.Name2: If Err.Number = 0 Then EntityKind = "component": Exit Function
    Err.Clear
    EntityKind = "unknown"
End Function

Function EntityJson(ent)
    Dim kind, s, x, k, e, g
    On Error Resume Next
    If Not HasObj(ent) Then EntityJson = "null": Exit Function
    kind = EntityKind(ent)
    Note kind, ent
    Select Case kind
        Case "face": EntityJson = FaceJson(ent, True)
        Case "edge": EntityJson = EdgeJson(ent)
        Case "vertex": EntityJson = "{""kind"":""vertex"",""point"":" & NumArr(ent.GetPoint, 0, 3) & "}"
        Case "feature"
            s = "{""kind"":""feature"",""name"":" & JStr(ent.Name) & ",""type"":" & JStr(ent.GetTypeName2)
            If ent.GetTypeName2 = "RefPlane" Then s = s & ",""transform"":" & TransformJson(ent.GetSpecificFeature2.Transform)
            Err.Clear
            EntityJson = s & "}"
        Case "refPlane": EntityJson = "{""kind"":""refPlane"",""transform"":" & TransformJson(ent.Transform) & "}"
        Case "refAxis": EntityJson = "{""kind"":""refAxis"",""params"":" & NumArr(ent.GetRefAxisParams, 0, 6) & "}"
        Case "refPoint": EntityJson = "{""kind"":""refPoint"",""at"":" & NumArr(ent.GetRefPoint.ArrayData, 0, 3) & "}"
        Case "loop"
            x = ent.GetEdges
            s = "{""kind"":""loop"",""edges"":["
            k = 0
            If IsArray(x) Then
                For Each e In x
                    If k > 0 Then s = s & ","
                    s = s & EdgeJson(e)
                    k = k + 1
                Next
            End If
            EntityJson = s & "]}"
        Case "contour"
            x = ent.GetSketchSegments
            s = "{""kind"":""contour"",""segments"":["
            k = 0
            If IsArray(x) Then
                For Each g In x
                    If k > 0 Then s = s & ","
                    s = s & JStr(SegId(g))
                    k = k + 1
                Next
            End If
            s = s & "]"
            Set x = ent.GetSketch
            If HasObj(x) Then s = s & ",""toSketch"":" & TransformJson(x.ModelToSketchTransform)
            Err.Clear
            EntityJson = s & "}"
        Case "region"
            EntityJson = "{""kind"":""region""}"
        Case "sketchPoint"
            EntityJson = "{""kind"":""sketchPoint"",""id"":" & JStr(PointId(ent)) & ",""at"":[" & Num(ent.X) & "," & Num(ent.Y) & "," & Num(ent.Z) & "]}"
        Case "sketchSegment"
            EntityJson = "{""kind"":""sketchSegment"",""id"":" & JStr(SegId(ent)) & "}"
        Case "component"
            EntityJson = "{""kind"":""component"",""name"":" & JStr(ent.Name2) & "}"
        Case "body"
            EntityJson = "{""kind"":""body"",""name"":" & JStr(ent.Name) & "}"
        Case Else
            EntityJson = "{""kind"":" & JStr(kind) & ",""typeName"":" & JStr(TypeName(ent)) & "}"
    End Select
    If Err.Number <> 0 Then
        AddErr "Entity (" & kind & ", " & TypeName(ent) & "): " & Err.Description
        Err.Clear
    End If
End Function

' A face: a point inside it (the middle of its largest display triangle, put back onto the face), its outward
' normal there, its surface type and parameters, and its box.
Function FaceJson(face, full)
    Dim t, i, best, area, ax, ay, az, bx, bwy, bz, cx, cy, cz, ux, uy, uz, p, surf, ev, sense, nx, ny, nz, s, kind, params
    On Error Resume Next
    t = face.GetTessTriangles(True)
    best = -1: cx = 0: cy = 0: cz = 0
    If IsArray(t) Then
        For i = LBound(t) To UBound(t) - 8 Step 9
            ax = CDbl(t(i + 3)) - CDbl(t(i)): ay = CDbl(t(i + 4)) - CDbl(t(i + 1)): az = CDbl(t(i + 5)) - CDbl(t(i + 2))
            bx = CDbl(t(i + 6)) - CDbl(t(i)): bwy = CDbl(t(i + 7)) - CDbl(t(i + 1)): bz = CDbl(t(i + 8)) - CDbl(t(i + 2))
            ux = ay * bz - az * bwy: uy = az * bx - ax * bz: uz = ax * bwy - ay * bx
            area = ux * ux + uy * uy + uz * uz
            If area > best Then
                best = area
                cx = (CDbl(t(i)) + CDbl(t(i + 3)) + CDbl(t(i + 6))) / 3
                cy = (CDbl(t(i + 1)) + CDbl(t(i + 4)) + CDbl(t(i + 7))) / 3
                cz = (CDbl(t(i + 2)) + CDbl(t(i + 5)) + CDbl(t(i + 8))) / 3
            End If
        Next
    End If
    Err.Clear
    p = face.GetClosestPointOn(CDbl(cx), CDbl(cy), CDbl(cz))
    If Not IsArray(p) Then p = Array(cx, cy, cz)
    Err.Clear
    Set surf = face.GetSurface
    ev = surf.EvaluateAtPoint(CDbl(p(0)), CDbl(p(1)), CDbl(p(2)))
    sense = face.FaceInSurfaceSense
    If IsArray(ev) Then
        nx = ev(0): ny = ev(1): nz = ev(2)
        If sense Then nx = -nx: ny = -ny: nz = -nz
    Else
        ev = face.Normal
        If IsArray(ev) Then nx = ev(0): ny = ev(1): nz = ev(2)
    End If
    Err.Clear
    kind = "other": params = "null"
    If surf.IsPlane Then
        kind = "plane": params = NumArr(surf.PlaneParams, 0, 6)
    ElseIf surf.IsCylinder Then
        kind = "cylinder": params = NumArr(surf.CylinderParams, 0, 7)
    ElseIf surf.IsCone Then
        kind = "cone": params = NumArr(surf.ConeParams, 0, 8)
    ElseIf surf.IsSphere Then
        kind = "sphere": params = NumArr(surf.SphereParams, 0, 4)
    ElseIf surf.IsTorus Then
        kind = "torus": params = NumArr(surf.TorusParams, 0, 8)
    End If
    Err.Clear
    s = "{""kind"":""face"",""point"":[" & Num(p(0)) & "," & Num(p(1)) & "," & Num(p(2)) & "],""normal"":[" & Num(nx) & "," & Num(ny) & "," & Num(nz) & "]"
    s = s & ",""surface"":" & JStr(kind) & ",""params"":" & params
    If full Then s = s & ",""box"":" & NumArr(face.GetBox, 0, 6)
    Err.Clear
    FaceJson = s & "}"
End Function

' An edge: its middle point, its ends, and its curve type and parameters.
Function EdgeJson(edge)
    Dim crv, cp, u0, u1, ev, s, kind, params, sp, ep
    On Error Resume Next
    Set crv = edge.GetCurve
    Set cp = edge.GetCurveParams3
    u0 = cp.UMinValue: u1 = cp.UMaxValue
    sp = cp.StartPoint: ep = cp.EndPoint
    ev = crv.Evaluate2(CDbl((u0 + u1) / 2), CLng(0))
    Err.Clear
    kind = "other": params = "null"
    If crv.IsLine Then
        kind = "line": params = NumArr(crv.LineParams, 0, 6)
    ElseIf crv.IsCircle Then
        kind = "circle": params = NumArr(crv.CircleParams, 0, 7)
    ElseIf crv.IsEllipse Then
        kind = "ellipse"
    End If
    Err.Clear
    s = "{""kind"":""edge"",""point"":" & NumArr(ev, 0, 3) & ",""start"":" & NumArr(sp, 0, 3) & ",""end"":" & NumArr(ep, 0, 3)
    s = s & ",""curve"":" & JStr(kind) & ",""params"":" & params & "}"
    If Err.Number <> 0 Then AddErr "Edge: " & Err.Description: Err.Clear
    EdgeJson = s
End Function

' The faces a feature made, as seen in the finished part (some may have been cut away by later features): they show
' which way it went.
Function FeatureFaces(feat)
    Dim faces, face, s, k
    On Error Resume Next
    faces = feat.GetFaces
    s = "["
    k = 0
    If IsArray(faces) Then
        For Each face In faces
            If k >= MAX_FACES_PER_FEATURE Then Exit For
            If HasObj(face) Then
                If k > 0 Then s = s & ","
                s = s & FaceJson(face, True)
                k = k + 1
            End If
        Next
    End If
    Err.Clear
    FeatureFaces = s & "]"
End Function

' Where each end of an extrusion stops when it goes up to a vertex, face or plane.
Function ExtrudeEnds(doc, feat)
    Dim data, s, i, fwd, cond, ent, ok
    On Error Resume Next
    Set data = feat.GetDefinition
    s = "["
    If HasObj(data) Then
        ok = data.AccessSelections(doc, Nothing)
        Err.Clear
        For i = 0 To 1
            fwd = (i = 0)
            If i > 0 Then s = s & ","
            cond = data.GetEndCondition(CBool(fwd))
            Set ent = Nothing
            If cond = 3 Or cond = 4 Or cond = 5 Or cond = 7 Then
                Set gEval = data
                If fwd Then Set ent = Eval("gEval.GetEndConditionReference(True, 0)") Else Set ent = Eval("gEval.GetEndConditionReference(False, 0)")
                If Err.Number <> 0 Then
                    Err.Clear
                    ' Hole Wizard style properties when the reference call is not available late-bound.
                    Set ent = Nothing
                End If
            End If
            Err.Clear
            s = s & "{""condition"":" & Num(cond) & ",""reference"":" & EntityJson(ent) & "}"
        Next
        data.ReleaseSelectionAccess
        Err.Clear
    End If
    Set data = Nothing
    ExtrudeEnds = s & "]"
End Function

Function FilletItems(doc, feat)
    Dim data, n, i, item, s, ok
    On Error Resume Next
    FilletItems = "[]"
    Set data = feat.GetDefinition
    If Not HasObj(data) Then Exit Function
    If Not data.IsMultipleRadius Then Exit Function
    n = data.FilletItemsCount
    ok = data.AccessSelections(doc, Nothing)
    s = "["
    For i = 0 To n - 1
        Set item = data.GetFilletItemAtIndex(CLng(i))
        If i > 0 Then s = s & ","
        s = s & "{""entity"":" & EntityJson(item) & ",""radius"":" & Num(data.GetRadius(item)) & "}"
        Err.Clear
    Next
    data.ReleaseSelectionAccess
    Err.Clear
    FilletItems = s & "]"
End Function

Function PatternTransforms(feat, kind)
    Dim data, n, i, s, xf
    On Error Resume Next
    Set data = feat.GetDefinition
    PatternTransforms = "[]"
    If Not HasObj(data) Then Exit Function
    If kind = "linear" Then
        n = data.D1TotalInstances
        If data.IsDirection2Specified Then n = n + data.D2TotalInstances
    Else
        n = data.TotalInstances
    End If
    Err.Clear
    If n > MAX_PATTERN_TRANSFORMS Then n = MAX_PATTERN_TRANSFORMS
    s = "["
    For i = 1 To n
        Set xf = data.GetTransform(CLng(i))
        If i > 1 Then s = s & ","
        s = s & "{""instance"":" & i & ",""transform"":" & TransformJson(xf) & "}"
        Err.Clear
    Next
    Set data = Nothing
    PatternTransforms = s & "]"
End Function

Function FeatureNames(arr)
    Dim s, x, k
    On Error Resume Next
    s = "["
    k = 0
    If IsArray(arr) Then
        For Each x In arr
            If HasObj(x) Then
                If k > 0 Then s = s & ","
                s = s & JStr(x.Name)
                k = k + 1
            End If
        Next
    End If
    Err.Clear
    FeatureNames = s & "]"
End Function

Function TransformJson(xf)
    On Error Resume Next
    If Not HasObj(xf) Then TransformJson = "null": Exit Function
    TransformJson = NumArr(xf.ArrayData, 0, 16)
    If Err.Number <> 0 Then TransformJson = "null": Err.Clear
End Function

' ---- Sketches -----------------------------------------------------------------------------------------------------

Function PointId(p)
    Dim id
    On Error Resume Next
    id = p.GetID
    If IsArray(id) Then PointId = "p" & id(LBound(id)) & "_" & id(LBound(id) + 1) Else PointId = "p?"
    Err.Clear
End Function

' Segment ids are unique only per segment type, so the type is part of the id.
Function SegId(seg)
    Dim id, t
    On Error Resume Next
    t = seg.GetType
    id = seg.GetID
    If IsArray(id) Then SegId = "s" & t & "_" & id(LBound(id)) & "_" & id(LBound(id) + 1) Else SegId = "s?"
    Err.Clear
End Function

Function PointJson(p)
    On Error Resume Next
    PointJson = "{""id"":" & JStr(PointId(p)) & ",""x"":" & Num(p.X) & ",""y"":" & Num(p.Y) & ",""z"":" & Num(p.Z) & ",""type"":" & Num(p.Type) & "}"
    Err.Clear
End Function

Function SketchJson(feat)
    Dim sk, s, pts, p, points, segs, seg, k, rels, rel, cs, c, x, g, j
    On Error Resume Next
    Set sk = feat.GetSpecificFeature2
    If Not HasObj(sk) Then
        AddErr "GetSpecificFeature2 (sketch): " & Err.Description
        Err.Clear
        SketchJson = "null"
        Exit Function
    End If
    Note "sketch", sk
    Set points = CreateObject("Scripting.Dictionary")
    s = "{""is3d"":" & JBool(sk.Is3D) & ",""toSketch"":" & TransformJson(sk.ModelToSketchTransform)
    Err.Clear
    pts = sk.GetSketchPoints2
    If IsArray(pts) Then
        For Each p In pts
            If HasObj(p) Then
                Note "sketch point", p
                AddPoint points, p
            End If
        Next
    End If
    Err.Clear

    s = s & ",""segments"":["
    k = 0
    segs = sk.GetSketchSegments
    If IsArray(segs) Then
        For Each seg In segs
            If HasObj(seg) Then
                If k > 0 Then s = s & ","
                s = s & SegmentJson(seg, points)
                k = k + 1
            End If
        Next
    End If
    s = s & "]"
    Err.Clear

    s = s & ",""relations"":["
    k = 0
    rels = sk.RelationManager.GetRelations(CLng(0))
    If Err.Number <> 0 Then AddErr "GetRelations: " & Err.Description: Err.Clear
    If IsArray(rels) Then
        For Each rel In rels
            If HasObj(rel) Then
                If k > 0 Then s = s & ","
                s = s & RelationJson(rel, points)
                k = k + 1
            End If
        Next
    End If
    s = s & "]"
    Err.Clear

    s = s & ",""contours"":["
    k = 0
    cs = sk.GetSketchContours
    If IsArray(cs) Then
        For Each c In cs
            If HasObj(c) Then
                If k > 0 Then s = s & ","
                s = s & "["
                x = c.GetSketchSegments
                If IsArray(x) Then
                    j = 0
                    For Each g In x
                        If j > 0 Then s = s & ","
                        s = s & JStr(SegId(g))
                        j = j + 1
                    Next
                End If
                s = s & "]"
                k = k + 1
            End If
        Next
    End If
    s = s & "]"
    Err.Clear

    ' Points last: segments and relations may have met points the point list does not hold.
    s = s & ",""points"":["
    k = 0
    For Each x In points.Items
        If k > 0 Then s = s & ","
        s = s & x
        k = k + 1
    Next
    SketchJson = s & "]}"
End Function

Sub AddPoint(points, p)
    Dim id
    On Error Resume Next
    id = PointId(p)
    If Not points.Exists(id) Then points.Add id, PointJson(p)
    Err.Clear
End Sub

Function PointRef(p, points)
    On Error Resume Next
    If Not HasObj(p) Then PointRef = "null": Exit Function
    AddPoint points, p
    PointRef = JStr(PointId(p))
End Function

Function SegmentJson(seg, points)
    Dim t, s, x, k, p
    On Error Resume Next
    t = seg.GetType
    s = "{""id"":" & JStr(SegId(seg)) & ",""type"":" & Num(t) & ",""construction"":" & JBool(seg.ConstructionGeometry) & ",""length"":" & Num(seg.GetLength)
    Err.Clear
    Select Case t
        Case 0
            Note "sketch line", seg
            s = s & ",""kind"":""line"",""start"":" & PointRef(seg.GetStartPoint2, points) & ",""end"":" & PointRef(seg.GetEndPoint2, points)
            s = s & ",""infinite"":" & JBool(seg.Infinite)
        Case 1
            Note "sketch arc", seg
            s = s & ",""kind"":""arc"",""start"":" & PointRef(seg.GetStartPoint2, points) & ",""end"":" & PointRef(seg.GetEndPoint2, points)
            s = s & ",""centre"":" & PointRef(seg.GetCenterPoint2, points) & ",""radius"":" & Num(seg.GetRadius)
            s = s & ",""dir"":" & Num(seg.GetRotationDir) & ",""circle"":" & JBool(seg.IsCircle <> 0) & ",""normal"":" & NumArr(seg.GetNormalVector, 0, 3)
        Case 2
            Note "sketch ellipse", seg
            s = s & ",""kind"":""ellipse"",""start"":" & PointRef(seg.GetStartPoint2, points) & ",""end"":" & PointRef(seg.GetEndPoint2, points)
            s = s & ",""centre"":" & PointRef(seg.GetCenterPoint2, points) & ",""major"":" & PointRef(seg.GetMajorPoint2, points)
            s = s & ",""minor"":" & PointRef(seg.GetMinorPoint2, points) & ",""dir"":" & Num(seg.GetRotationDir)
        Case 3
            Note "sketch spline", seg
            s = s & ",""kind"":""spline"",""points"":["
            x = seg.GetPoints2
            k = 0
            If IsArray(x) Then
                For Each p In x
                    If k > 0 Then s = s & ","
                    s = s & PointRef(p, points)
                    k = k + 1
                Next
            End If
            s = s & "],""bspline"":" & SplineJson(seg)
        Case 4
            s = s & ",""kind"":""text"""
        Case 5
            Note "sketch parabola", seg
            s = s & ",""kind"":""parabola"",""start"":" & PointRef(seg.GetStartPoint2, points) & ",""end"":" & PointRef(seg.GetEndPoint2, points)
            s = s & ",""focus"":" & PointRef(seg.GetFocalPoint2, points) & ",""apex"":" & PointRef(seg.GetApexPoint2, points)
        Case Else
            s = s & ",""kind"":""unknown"""
    End Select
    If Err.Number <> 0 Then
        AddErr "Segment " & SegId(seg) & " (type " & t & ", " & TypeName(seg) & "): " & Err.Description
        Err.Clear
    End If
    SegmentJson = s & "}"
End Function

' The exact B-spline of a sketch spline (as SolidWorks holds it), so the curve is not just interpolated again.
Function SplineJson(seg)
    Dim crv, spd, cps, kn, ok1, ok2, s
    On Error Resume Next
    Set crv = seg.GetCurve
    Set spd = crv.GetBCurveParams5(False, False, True, False)
    If Not HasObj(spd) Then
        AddErr "Spline parameters: " & Err.Description
        Err.Clear
        SplineJson = "null"
        Exit Function
    End If
    ok1 = spd.GetControlPoints(cps)
    ok2 = spd.GetKnotPoints(kn)
    s = "{""dimension"":" & Num(spd.Dimension) & ",""order"":" & Num(spd.Order) & ",""count"":" & Num(spd.ControlPointsCount)
    s = s & ",""periodic"":" & Num(spd.Periodic) & ",""controlPoints"":" & ValueJson(cps) & ",""knots"":" & ValueJson(kn) & "}"
    If Err.Number <> 0 Then AddErr "Spline parameters: " & Err.Description: Err.Clear
    SplineJson = s
End Function

Function RelationJson(rel, points)
    Dim s, t, ents, types, i, k, e, et, dd, dm, v
    On Error Resume Next
    t = rel.GetRelationType
    s = "{""type"":" & Num(t) & ",""suppressed"":" & JBool(rel.Suppressed)
    Err.Clear
    ents = rel.GetEntities
    types = rel.GetEntitiesType
    s = s & ",""entities"":["
    k = 0
    If IsArray(ents) Then
        For i = LBound(ents) To UBound(ents)
            If k > 0 Then s = s & ","
            et = 0
            If IsArray(types) Then et = types(i)
            Set e = Nothing
            Set e = ents(i)
            s = s & "{""type"":" & Num(et)
            If HasObj(e) Then
                Select Case et
                    Case 2
                        s = s & ",""ref"":" & PointRef(e, points)
                    Case 3, 4, 5, 6, 7
                        s = s & ",""ref"":" & JStr(SegId(e))
                    Case Else
                        s = s & ",""entity"":" & EntityJson(e)
                End Select
            End If
            s = s & "}"
            Err.Clear
            k = k + 1
        Next
    End If
    s = s & "]"
    Set dd = rel.GetDisplayDimension
    If HasObj(dd) Then
        Set dm = dd.GetDimension2(CLng(0))
        v = dm.SystemValue
        s = s & ",""dimension"":{""value"":" & Num(v) & ",""type"":" & Num(dd.Type2) & ",""driven"":" & Num(dm.DrivenState) _
            & ",""name"":" & JStr(dm.FullName) & "}"
    End If
    If Err.Number <> 0 Then AddErr "Relation (type " & t & "): " & Err.Description: Err.Clear
    RelationJson = s & "}"
End Function

' ---- Assembly -------------------------------------------------------------------------------------------------------

Function AssemblyJson(doc, path)
    Dim b, conf, comps, comp, k, dir, feat, sub1, mates, box
    On Error Resume Next
    dir = fso.GetParentFolderName(path)
    Set b = New Buf
    b.Add "{""format"":""jarvis-sw-history"",""version"":" & FORMAT_VERSION & ",""kind"":""assembly"","
    b.Add """units"":{""length"":""m"",""angle"":""rad"",""area"":""m^2"",""volume"":""m^3"",""mass"":""kg""},"
    b.Add """transforms"":""MathTransform.ArrayData: 9 rotation, 3 translation, 1 scale, 3 unused"","
    b.Add """exporter"":{""script"":""JarvisHistoryExport.vbs"",""version"":" & JStr(SCRIPT_VERSION) & ",""solidworks"":" & JStr(swApp.RevisionNumber) & ",""date"":" & JStr(Stamp(Now)) & "},"
    conf = doc.ConfigurationManager.ActiveConfiguration.Name
    Err.Clear
    b.Add """document"":{""file"":" & JStr(fso.GetFileName(path)) & ",""path"":" & JStr(path) & ",""title"":" & JStr(doc.GetTitle) & ",""configuration"":" & JStr(conf) & "},"
    Err.Clear
    b.Add """mass"":" & MassJson(doc) & ","
    Set box = New Box3
    box.AddCorners doc.GetBox(CLng(0))
    Err.Clear
    b.Add """box"":" & box.Json & ","

    b.Add """components"":["
    comps = doc.GetComponents(True)
    If Err.Number <> 0 Then LogLine "GetComponents could not be read: " & Err.Description: Err.Clear
    k = 0
    If IsArray(comps) Then
        For Each comp In comps
            If HasObj(comp) Then
                If k > 0 Then b.Add ","
                b.Add ComponentJson(comp, dir)
                k = k + 1
            End If
        Next
    End If
    b.Add "],"
    LogLine k & " top-level components"

    b.Add """mates"":["
    k = 0
    Set feat = doc.FirstFeature
    Do While HasObj(feat)
        If feat.GetTypeName2 = "MateGroup" Then
            Set sub1 = feat.GetFirstSubFeature
            Do While HasObj(sub1)
                If k > 0 Then b.Add ","
                b.Add MateJson(sub1)
                k = k + 1
                Set sub1 = sub1.GetNextSubFeature
            Loop
        End If
        Set feat = feat.GetNextFeature
    Loop
    Err.Clear
    b.Add "]}"
    LogLine k & " mates"
    AssemblyJson = b.Text
End Function

Function ComponentJson(comp, dir)
    Dim s, p, rel, kids, kid, k, sup, fixedState
    On Error Resume Next
    Note "component", comp
    p = comp.GetPathName
    rel = p
    If LCase(Left(p, Len(dir) + 1)) = LCase(dir & "\") Then rel = Mid(p, Len(dir) + 2)
    s = "{""name"":" & JStr(comp.Name2) & ",""file"":" & JStr(rel) & ",""path"":" & JStr(p)
    s = s & ",""configuration"":" & JStr(comp.ReferencedConfiguration)
    Err.Clear
    sup = comp.GetSuppression
    s = s & ",""suppression"":" & Num(sup) & ",""suppressed"":" & JBool(comp.IsSuppressed)
    Err.Clear
    fixedState = comp.IsFixed
    If Err.Number = 0 Then s = s & ",""fixed"":" & JBool(fixedState)
    Err.Clear
    s = s & ",""visible"":" & Num(comp.Visible) & ",""excludeFromBOM"":" & JBool(comp.ExcludeFromBOM) & ",""virtual"":" & JBool(comp.IsVirtual)
    Err.Clear
    s = s & ",""transform"":" & TransformJson(comp.Transform2)
    Err.Clear
    s = s & ",""children"":["
    kids = comp.GetChildren
    k = 0
    If IsArray(kids) Then
        For Each kid In kids
            If HasObj(kid) Then
                If k > 0 Then s = s & ","
                s = s & ComponentJson(kid, dir)
                k = k + 1
            End If
        Next
    End If
    Err.Clear
    ComponentJson = s & "]}"
End Function

Function MateJson(mateFeat)
    Dim s, m, n, i, ment, comp, dd, sup, arr
    On Error Resume Next
    ReDim gErrs(15): gErrCount = 0
    s = "{""name"":" & JStr(mateFeat.Name) & ",""featureType"":" & JStr(mateFeat.GetTypeName2)
    arr = mateFeat.IsSuppressed2(CLng(1), Empty)
    If IsArray(arr) Then sup = CBool(arr(LBound(arr))) Else sup = False
    Err.Clear
    s = s & ",""suppressed"":" & JBool(sup)
    Set m = mateFeat.GetSpecificFeature2
    If HasObj(m) Then
        Note "mate", m
        s = s & ",""type"":" & Num(m.Type) & ",""alignment"":" & Num(m.Alignment) & ",""flipped"":" & JBool(m.Flipped)
        Err.Clear
        Set dd = m.DisplayDimension2(CLng(0))
        If HasObj(dd) Then s = s & ",""value"":" & Num(dd.GetDimension2(CLng(0)).SystemValue)
        Err.Clear
        s = s & ",""min"":" & Num(m.MinimumVariation) & ",""max"":" & Num(m.MaximumVariation)
        Err.Clear
        n = m.GetMateEntityCount
        s = s & ",""entities"":["
        For i = 0 To n - 1
            Set ment = m.MateEntity(CLng(i))
            If i > 0 Then s = s & ","
            s = s & "{""referenceType"":" & Num(ment.ReferenceType2)
            Set comp = ment.ReferenceComponent
            If HasObj(comp) Then s = s & ",""component"":" & JStr(comp.Name2)
            Err.Clear
            s = s & ",""params"":" & ValueJson(ment.EntityParams) & "}"
            Err.Clear
        Next
        s = s & "]"
    End If
    MateJson = s & ",""errors"":" & ErrsJson() & "}"
End Function

' ---- Output helpers -------------------------------------------------------------------------------------------------

Class Buf
    Private parts, n
    Private Sub Class_Initialize()
        ReDim parts(255)
        n = 0
    End Sub
    Public Sub Add(s)
        If n > UBound(parts) Then ReDim Preserve parts(2 * UBound(parts) + 1)
        parts(n) = s
        n = n + 1
    End Sub
    Public Function Text()
        ReDim Preserve parts(n)
        Text = Join(parts, "")
    End Function
End Class

Class Box3
    Private mLo(2), mHi(2), mNone
    Private Sub Class_Initialize()
        mNone = True
    End Sub
    Public Sub AddPoint(x, y, z)
        Dim v, k
        v = Array(x, y, z)
        For k = 0 To 2
            If mNone Then
                mLo(k) = v(k): mHi(k) = v(k)
            Else
                If v(k) < mLo(k) Then mLo(k) = v(k)
                If v(k) > mHi(k) Then mHi(k) = v(k)
            End If
        Next
        mNone = False
    End Sub
    Public Sub AddCorners(c)
        On Error Resume Next
        If Not IsArray(c) Then Exit Sub
        If UBound(c) - LBound(c) < 5 Then Exit Sub
        AddPoint CDbl(c(LBound(c))), CDbl(c(LBound(c) + 1)), CDbl(c(LBound(c) + 2))
        AddPoint CDbl(c(LBound(c) + 3)), CDbl(c(LBound(c) + 4)), CDbl(c(LBound(c) + 5))
    End Sub
    Public Sub AddBox(other)
        If other.HasNone Then Exit Sub
        AddPoint other.Low(0), other.Low(1), other.Low(2)
        AddPoint other.High(0), other.High(1), other.High(2)
    End Sub
    Public Function HasNone()
        HasNone = mNone
    End Function
    Public Function Low(k)
        Low = mLo(k)
    End Function
    Public Function High(k)
        High = mHi(k)
    End Function
    Public Function Json()
        If mNone Then
            Json = "null"
        Else
            Json = "{""min"":[" & Num(mLo(0)) & "," & Num(mLo(1)) & "," & Num(mLo(2)) & "],""max"":[" & Num(mHi(0)) & "," & Num(mHi(1)) & "," & Num(mHi(2)) & "]}"
        End If
    End Function
End Class

Function HasObj(x)
    HasObj = False
    If IsObject(x) Then
        If Not x Is Nothing Then HasObj = True
    End If
End Function

' A number with a dot as decimal separator whatever Windows uses, at full precision; null when not a number.
Function Num(x)
    Dim s
    On Error Resume Next
    Num = "null"
    If IsArray(x) Or IsObject(x) Then Exit Function
    If IsNull(x) Or IsEmpty(x) Then Exit Function
    If VarType(x) = 11 Then
        If x Then Num = "1" Else Num = "0"
        Exit Function
    End If
    If Not IsNumeric(x) Then Exit Function
    s = CStr(CDbl(x))
    If Err.Number <> 0 Then Err.Clear: Exit Function
    If decSep <> "." Then s = Replace(s, decSep, ".")
    ' Not a number or infinite prints as 1.#QNAN or 1.#INF.
    If InStr(s, "#") > 0 Or InStr(LCase(s), "n") > 0 Then Exit Function
    Num = s
End Function

Function NumArr(arr, first, count)
    Dim s, i, n
    On Error Resume Next
    If Not IsArray(arr) Then NumArr = "null": Exit Function
    n = UBound(arr) - LBound(arr) + 1
    If count > 0 And count < n Then n = count
    s = "["
    For i = 0 To n - 1
        If i > 0 Then s = s & ","
        s = s & Num(arr(LBound(arr) + first + i))
    Next
    NumArr = s & "]"
End Function

Function JBool(b)
    On Error Resume Next
    If CBool(b) Then JBool = "true" Else JBool = "false"
    If Err.Number <> 0 Then JBool = "null": Err.Clear
End Function

' A JSON string; anything outside printable ASCII is written as \uXXXX, so the file is plain ASCII.
Function JStr(v)
    Dim s, i, c, code, out
    On Error Resume Next
    If IsNull(v) Or IsEmpty(v) Or IsObject(v) Or IsArray(v) Then JStr = "null": Exit Function
    s = CStr(v)
    out = ""
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        code = AscW(c)
        If code < 0 Then code = code + 65536
        If code = 34 Then
            out = out & "\"""
        ElseIf code = 92 Then
            out = out & "\\"
        ElseIf code < 32 Or code > 126 Then
            out = out & "\u" & Right("000" & Hex(code), 4)
        Else
            out = out & c
        End If
    Next
    JStr = """" & out & """"
End Function

Function Ascii(s)
    Dim i, c, code, out
    out = ""
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        code = AscW(c)
        If code < 0 Then code = code + 65536
        If code > 126 Or (code < 32 And code <> 9) Then out = out & "?" Else out = out & c
    Next
    Ascii = out
End Function

Sub LogLine(msg)
    If gLogCount > UBound(gLog) Then ReDim Preserve gLog(2 * UBound(gLog) + 1)
    gLog(gLogCount) = msg
    gLogCount = gLogCount + 1
End Sub

Function LogText()
    Dim i, s
    s = ""
    For i = 0 To gLogCount - 1
        s = s & Ascii(gLog(i)) & vbCrLf
    Next
    LogText = s
End Function

Function LogArray()
    Dim i, s
    s = "["
    For i = 0 To gLogCount - 1
        If i > 0 Then s = s & ","
        s = s & JStr(gLog(i))
    Next
    LogArray = s & "]"
End Function

Sub AddErr(msg)
    If gErrCount > UBound(gErrs) Then ReDim Preserve gErrs(2 * UBound(gErrs) + 1)
    gErrs(gErrCount) = msg
    gErrCount = gErrCount + 1
End Sub

Function ErrsJson()
    Dim i, s
    s = "["
    For i = 0 To gErrCount - 1
        If i > 0 Then s = s & ","
        s = s & JStr(gErrs(i))
    Next
    ErrsJson = s & "]"
End Function

' The COM type name of each kind of object, once per document: says how SolidWorks hands its objects to a script.
Sub Note(kind, obj)
    On Error Resume Next
    If gTypeNames.Exists(kind) Then Exit Sub
    gTypeNames.Add kind, True
    LogLine "Type of " & kind & ": " & TypeName(obj)
    Err.Clear
End Sub

Function WriteText(path, text)
    Dim ts
    On Error Resume Next
    WriteText = False
    Set ts = fso.CreateTextFile(path, True, False)
    If Err.Number <> 0 Then
        Summary "Could not write " & path & ": " & Err.Description
        Err.Clear
        Exit Function
    End If
    ts.Write text
    ts.Close
    If Err.Number <> 0 Then
        Summary "Could not write " & path & ": " & Err.Description
        Err.Clear
        Exit Function
    End If
    WriteText = True
End Function

Sub Summary(msg)
    Dim ts
    On Error Resume Next
    If gSummaryPath = "" Then Exit Sub
    Set ts = fso.OpenTextFile(gSummaryPath, 8, True, 0)
    ts.WriteLine Ascii(Stamp(Now) & "  " & msg)
    ts.Close
    Err.Clear
End Sub
